//! Round trips through the HTTP/3 gateway: a real HTTP/3 client (quinn + h3) on one side, a
//! stand-in for Mockttp (SOCKS5 custom-metadata, then TLS with a certificate from the same CA, then
//! HTTP/1.1) on the other. The test drives the gateway the way the core's `QuicDriver` does:
//! `on_datagram` for each datagram from the "phone", `poll` whenever `next_timeout` says so.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::{Buf, Bytes};
use rcgen::{BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{Notify, mpsc};
use tokio::time::{sleep_until, timeout};

use super::certs::{self, LeafIssuer};
use super::socket::{MAX_INBOUND, MAX_OUTBOUND, VirtualSocket};
use super::{OutDatagram, QuicGateway};
use crate::events::EventSink;

const PHONE: &str = "10.73.0.2";
const SERVER: &str = "93.184.216.34:443";
const HOST: &str = "example.test";

struct TestCa {
    cert_pem: String,
    key_pem: String,
}

impl TestCa {
    fn new(name: &str) -> Self {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::default();
        let mut subject = DistinguishedName::new();
        subject.push(DnType::CommonName, name);
        subject.push(DnType::OrganizationName, "Wirepane");
        params.distinguished_name = subject;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
        let cert = params.self_signed(&key).unwrap();
        Self { cert_pem: cert.pem(), key_pem: key.serialize_pem() }
    }

    fn der(&self) -> CertificateDer<'static> {
        CertificateDer::from_pem_slice(self.cert_pem.as_bytes()).unwrap()
    }
}

/// What the stand-in Mockttp saw for one request.
#[derive(Debug)]
struct Seen {
    tags: Vec<String>,
    connect: Vec<u8>,
    sni: Option<String>,
    head: String,
    body: Vec<u8>,
}

/// SOCKS5 with custom metadata (like mockttp's socks-server), then TLS, then one HTTP/1.1 request.
async fn fake_mockttp(ca: &TestCa) -> (SocketAddr, mpsc::UnboundedReceiver<Seen>) {
    let issuer = Arc::new(LeafIssuer::new(&ca.cert_pem, &ca.key_pem).unwrap());
    let mut tls = rustls::ServerConfig::builder_with_provider(certs::provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(certs::LeafResolver { issuer, fallback: None, passthrough: None }));
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (seen_tx, seen_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            let seen_tx = seen_tx.clone();
            tokio::spawn(async move {
                if let Err(error) = serve_one(stream, acceptor, seen_tx).await {
                    eprintln!("fake mockttp: {error:#}");
                }
            });
        }
    });
    (addr, seen_rx)
}

async fn serve_one(
    mut stream: TcpStream,
    acceptor: tokio_rustls::TlsAcceptor,
    seen: mpsc::UnboundedSender<Seen>,
) -> anyhow::Result<()> {
    let mut greeting = [0u8; 3];
    stream.read_exact(&mut greeting).await?;
    anyhow::ensure!(greeting == [5, 1, 0xDA], "greeting {greeting:?}");
    stream.write_all(&[5, 0xDA]).await?;
    let mut len = [0u8; 2];
    stream.read_exact(&mut len).await?;
    let mut metadata = vec![0u8; usize::from(u16::from_be_bytes(len))];
    stream.read_exact(&mut metadata).await?;
    let metadata: Value = serde_json::from_slice(&metadata)?;
    let tags = metadata["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tag| tag.as_str().unwrap().to_string())
        .collect();
    stream.write_all(&[5, 0]).await?;
    let mut request = [0u8; 4];
    stream.read_exact(&mut request).await?;
    anyhow::ensure!(request[..3] == [5, 1, 0] && request[3] == 1, "connect {request:?}");
    let mut connect = vec![0u8; 6];
    stream.read_exact(&mut connect).await?;
    connect.insert(0, 1);
    stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;

    let mut tls = acceptor.accept(stream).await?;
    let sni = tls.get_ref().1.server_name().map(String::from);
    let mut buffer = Vec::new();
    let head_end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
        let mut chunk = [0u8; 4096];
        let read = tls.read(&mut chunk).await?;
        anyhow::ensure!(read > 0, "closed before the request head");
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8(buffer[..head_end].to_vec())?;
    let mut rest = buffer[head_end..].to_vec();
    let lower = head.to_ascii_lowercase();
    let body = if lower.contains("transfer-encoding: chunked") {
        read_chunked(&mut tls, &mut rest).await?
    } else if let Some(length) = lower
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .map(|value| value.trim().parse::<usize>().unwrap())
    {
        while rest.len() < length {
            let mut chunk = [0u8; 4096];
            let read = tls.read(&mut chunk).await?;
            anyhow::ensure!(read > 0, "closed in the body");
            rest.extend_from_slice(&chunk[..read]);
        }
        rest[..length].to_vec()
    } else {
        Vec::new()
    };
    let path = head.split(' ').nth(1).unwrap_or("/").to_string();
    let is_head = head.starts_with("HEAD ");
    seen.send(Seen { tags, connect, sni, head, body: body.clone() }).ok();

    if path.starts_with("/until-close") {
        // No length and no chunking: the body ends when the connection does.
        tls.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nbody until the proxy closes").await?;
        tls.shutdown().await?;
        return Ok(());
    } else if path.starts_with("/no-content") {
        tls.write_all(b"HTTP/1.1 204 No Content\r\nx-test: empty\r\n\r\n").await?;
    } else if is_head {
        tls.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 1234\r\n\r\n").await?;
    } else if path.starts_with("/hello") {
        let text = "hello over h3";
        tls.write_all(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nx-test: yes\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n{text}",
                text.len()
            )
            .as_bytes(),
        )
        .await?;
    } else if path.starts_with("/echo") {
        // An interim answer first: the gateway must skip it and pass on only the final one.
        tls.write_all(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\ntransfer-encoding: chunked\r\n\r\n").await?;
        for piece in body.chunks(1000) {
            tls.write_all(format!("{:x}\r\n", piece.len()).as_bytes()).await?;
            tls.write_all(piece).await?;
            tls.write_all(b"\r\n").await?;
        }
        tls.write_all(b"0\r\nx-trailer: t\r\n\r\n").await?;
    } else if let Some(size) = path.strip_prefix("/big/") {
        let size: usize = size.parse()?;
        let body: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        tls.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {size}\r\n\r\n").as_bytes()).await?;
        tls.write_all(&body).await?;
    } else {
        tls.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n").await?;
    }
    tls.flush().await?;
    // Like Node, keep the connection open for the next request; the gateway closes it.
    let mut ignored = [0u8; 64];
    let _ = timeout(Duration::from_secs(5), tls.read(&mut ignored)).await;
    Ok(())
}

async fn read_chunked<S: tokio::io::AsyncRead + Unpin>(stream: &mut S, rest: &mut Vec<u8>) -> anyhow::Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        while !rest.windows(2).any(|w| w == b"\r\n") {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).await?;
            anyhow::ensure!(read > 0, "closed in a chunk line");
            rest.extend_from_slice(&chunk[..read]);
        }
        let end = rest.windows(2).position(|w| w == b"\r\n").unwrap();
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..end])?.trim(), 16)?;
        rest.drain(..end + 2);
        while rest.len() < size + 2 {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).await?;
            anyhow::ensure!(read > 0, "closed in a chunk");
            rest.extend_from_slice(&chunk[..read]);
        }
        if size == 0 {
            return Ok(body);
        }
        body.extend_from_slice(&rest[..size]);
        rest.drain(..size + 2);
    }
}

/// The core's side, like `core::quic::QuicDriver`: a UDP socket stands in for the tunnel. Each
/// datagram from the client goes to `on_datagram` as if the phone at 10.73.0.2 sent it to
/// 93.184.216.34:443; everything the gateway returns is checked and sent back to the client.
/// `use_notifier` adds the gateway's optional notifier to the wake-ups.
fn start_tunnel(gateway: Arc<Mutex<QuicGateway>>, socket: UdpSocket, use_notifier: bool) -> tokio::task::JoinHandle<()> {
    let server: SocketAddr = SERVER.parse().unwrap();
    let notifier = gateway.lock().unwrap().notifier();
    tokio::spawn(async move {
        let mut client: Option<SocketAddr> = None;
        let mut buf = vec![0u8; 65536];
        let never = Arc::new(Notify::new());
        let ready = if use_notifier { notifier } else { never };
        loop {
            let next = gateway.lock().unwrap().next_timeout();
            let far = Instant::now() + Duration::from_secs(3600);
            let out: Vec<OutDatagram> = tokio::select! {
                received = socket.recv_from(&mut buf) => {
                    let Ok((len, from)) = received else { return };
                    client = Some(from);
                    let phone = SocketAddr::new(PHONE.parse().unwrap(), from.port());
                    gateway.lock().unwrap().on_datagram("p1", phone, server, &buf[..len], Instant::now())
                }
                _ = sleep_until(tokio::time::Instant::from_std(next.unwrap_or(far))) => {
                    gateway.lock().unwrap().poll(Instant::now())
                }
                _ = ready.notified() => gateway.lock().unwrap().poll(Instant::now()),
            };
            for (from, to, payload) in out {
                assert_eq!(from, server, "answers must come from the server the phone dialled");
                assert_eq!(to.ip().to_string(), PHONE);
                if let Some(client) = client {
                    socket.send_to(&payload, client).await.ok();
                }
            }
        }
    })
}

struct Rig {
    gateway: Arc<Mutex<QuicGateway>>,
    tunnel_addr: SocketAddr,
    tunnel: tokio::task::JoinHandle<()>,
    seen: mpsc::UnboundedReceiver<Seen>,
    events: Arc<Mutex<Vec<Value>>>,
}

async fn rig(ca: &TestCa, use_notifier: bool) -> Rig {
    rig_with(ca, ca, use_notifier).await
}

/// `proxy_ca` signs the stand-in's TLS certificates; another CA than the gateway's plays a host
/// that Mockttp passes through to the real server.
async fn rig_with(ca: &TestCa, proxy_ca: &TestCa, use_notifier: bool) -> Rig {
    let (proxy, seen) = fake_mockttp(proxy_ca).await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        EventSink::from_fn(move |event| events.lock().unwrap().push(event))
    };
    let gateway = QuicGateway::new(&ca.cert_pem, &ca.key_pem, Arc::new(Mutex::new(proxy.to_string())), sink).unwrap();
    let gateway = Arc::new(Mutex::new(gateway));
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let tunnel_addr = socket.local_addr().unwrap();
    let tunnel = start_tunnel(gateway.clone(), socket, use_notifier);
    Rig { gateway, tunnel_addr, tunnel, seen, events }
}

type Client = h3::client::SendRequest<h3_quinn::OpenStreams, Bytes>;

async fn connect(tunnel: SocketAddr, trusted: CertificateDer<'static>) -> anyhow::Result<(quinn::Endpoint, Client)> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(trusted)?;
    let mut tls = rustls::ClientConfig::builder_with_provider(certs::provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"h3".to_vec()];
    let crypto = quinn::crypto::rustls::QuicClientConfig::try_from(tls)?;
    let mut endpoint = quinn::Endpoint::client("127.0.0.1:0".parse()?)?;
    endpoint.set_default_client_config(quinn::ClientConfig::new(Arc::new(crypto)));
    let connection = timeout(Duration::from_secs(10), endpoint.connect(tunnel, HOST)?).await??;
    let (mut driver, client) = h3::client::new(h3_quinn::Connection::new(connection)).await?;
    tokio::spawn(async move {
        let _ = std::future::poll_fn(|cx| driver.poll_close(cx)).await;
    });
    Ok((endpoint, client))
}

async fn fetch(client: &mut Client, method: &str, path: &str, body: Option<Vec<u8>>) -> anyhow::Result<(http::Response<()>, Vec<u8>)> {
    fetch_with(client, method, path, &[], body).await
}

async fn fetch_with(
    client: &mut Client,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Vec<u8>>,
) -> anyhow::Result<(http::Response<()>, Vec<u8>)> {
    let mut request = http::Request::builder()
        .method(method)
        .uri(format!("https://{HOST}{path}"))
        .header("user-agent", "wirepane-test")
        .header("cookie", "a=1")
        .header("cookie", "b=2");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = request.body(())?;
    let mut stream = client.send_request(request).await?;
    if let Some(body) = body {
        for piece in body.chunks(7000) {
            stream.send_data(Bytes::copy_from_slice(piece)).await?;
        }
    }
    stream.finish().await?;
    let response = stream.recv_response().await?;
    let mut received = Vec::new();
    while let Some(mut chunk) = stream.recv_data().await? {
        received.extend_from_slice(&chunk.copy_to_bytes(chunk.remaining()));
    }
    Ok((response, received))
}

async fn next_seen(seen: &mut mpsc::UnboundedReceiver<Seen>) -> Seen {
    timeout(Duration::from_secs(5), seen.recv()).await.expect("the proxy saw nothing").unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_round_trips_through_the_gateway_to_the_proxy() {
    let ca = TestCa::new("Wirepane Test CA");
    let mut rig = rig(&ca, false).await;
    let (endpoint, mut client) = connect(rig.tunnel_addr, ca.der()).await.unwrap();

    let (response, body) = timeout(Duration::from_secs(10), fetch(&mut client, "GET", "/hello?x=1", None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(body, b"hello over h3");
    assert_eq!(response.headers()["x-test"], "yes");
    assert_eq!(response.headers()["content-length"], "13");
    // HTTP/1.1-only headers must not reach an HTTP/3 client.
    assert!(response.headers().get("connection").is_none());
    assert!(response.headers().get("keep-alive").is_none());

    let seen = next_seen(&mut rig.seen).await;
    assert_eq!(
        seen.tags,
        ["wirepane-vpn", "wirepane-vpn-peer:p1", "wirepane-vpn-h3", "wirepane-vpn-sni:example.test"]
    );
    assert_eq!(seen.connect, [1, 93, 184, 216, 34, 1, 187], "CONNECT goes to the server the phone dialled");
    assert_eq!(seen.sni.as_deref(), Some(HOST));
    assert!(seen.head.starts_with("GET /hello?x=1 HTTP/1.1\r\nhost: example.test\r\n"), "{}", seen.head);
    assert!(seen.head.contains("\r\ncookie: a=1; b=2\r\n"), "{}", seen.head);
    assert!(seen.head.contains("\r\nuser-agent: wirepane-test\r\n"), "{}", seen.head);
    assert!(seen.body.is_empty());

    // A second request on the same connection, and a large body that needs flow control.
    let (response, body) = timeout(Duration::from_secs(20), fetch(&mut client, "GET", "/big/300000", None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(body.len(), 300_000);
    assert!(body.iter().enumerate().all(|(i, byte)| *byte == (i % 251) as u8));
    next_seen(&mut rig.seen).await;

    endpoint.close(0u32.into(), b"done");
    rig.tunnel.abort();
    assert!(rig.events.lock().unwrap().is_empty(), "no errors: {:?}", rig.events.lock().unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn polling_stops_once_the_phone_is_gone() {
    let ca = TestCa::new("Wirepane Test CA");
    let mut rig = rig(&ca, false).await;
    assert!(rig.gateway.lock().unwrap().next_timeout().is_none(), "idle before any datagram");
    let (endpoint, mut client) = connect(rig.tunnel_addr, ca.der()).await.unwrap();
    fetch(&mut client, "GET", "/hello", None).await.unwrap();
    next_seen(&mut rig.seen).await;
    assert!(rig.gateway.lock().unwrap().next_timeout().is_some(), "polled while a connection is open");
    endpoint.close(0u32.into(), b"done");
    // The close goes out, the server drains the connection, then the 2 s after the last datagram pass.
    let deadline = Instant::now() + Duration::from_secs(10);
    while rig.gateway.lock().unwrap().next_timeout().is_some() {
        assert!(Instant::now() < deadline, "the gateway still wants polling 10 s after the phone left");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    rig.tunnel.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_bodies_stream_both_ways() {
    let ca = TestCa::new("Wirepane Test CA");
    let mut rig = rig(&ca, true).await;
    let (endpoint, mut client) = connect(rig.tunnel_addr, ca.der()).await.unwrap();

    let upload: Vec<u8> = (0..50_000u32).map(|i| (i % 199) as u8).collect();
    let (response, body) = timeout(Duration::from_secs(20), fetch(&mut client, "POST", "/echo", Some(upload.clone())))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 201, "the 100 Continue before it is skipped");
    assert_eq!(body, upload);
    let seen = next_seen(&mut rig.seen).await;
    assert!(seen.head.starts_with("POST /echo HTTP/1.1\r\n"), "{}", seen.head);
    assert!(seen.head.contains("\r\ntransfer-encoding: chunked\r\n"), "{}", seen.head);
    assert_eq!(seen.body, upload);

    // A POST without a body says so with content-length: 0.
    let (response, body) = fetch(&mut client, "POST", "/echo", None).await.unwrap();
    assert_eq!(response.status(), 201);
    assert!(body.is_empty());
    let seen = next_seen(&mut rig.seen).await;
    assert!(seen.head.contains("\r\ncontent-length: 0\r\n"), "{}", seen.head);

    endpoint.close(0u32.into(), b"done");
    rig.tunnel.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn other_body_framings_round_trip() {
    let ca = TestCa::new("Wirepane Test CA");
    let mut rig = rig(&ca, false).await;
    let (endpoint, mut client) = connect(rig.tunnel_addr, ca.der()).await.unwrap();
    let within = Duration::from_secs(10);

    let (response, body) = timeout(within, fetch(&mut client, "GET", "/until-close", None)).await.unwrap().unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(body, b"body until the proxy closes");
    next_seen(&mut rig.seen).await;

    let (response, body) = timeout(within, fetch(&mut client, "GET", "/no-content", None)).await.unwrap().unwrap();
    assert_eq!(response.status(), 204);
    assert_eq!(response.headers()["x-test"], "empty");
    assert!(body.is_empty());
    next_seen(&mut rig.seen).await;

    // HEAD keeps the length of the body it doesn't get.
    let (response, body) = timeout(within, fetch(&mut client, "HEAD", "/hello", None)).await.unwrap().unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-length"], "1234");
    assert!(body.is_empty());
    next_seen(&mut rig.seen).await;

    // A body with a declared length goes as it is, not chunked.
    let upload = vec![b'u'; 9000];
    let (response, body) = timeout(within, fetch_with(&mut client, "PUT", "/echo", &[("content-length", "9000")], Some(upload.clone())))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 201);
    assert_eq!(body, upload);
    let seen = next_seen(&mut rig.seen).await;
    assert!(seen.head.contains("\r\ncontent-length: 9000\r\n"), "{}", seen.head);
    assert!(!seen.head.contains("transfer-encoding"), "{}", seen.head);
    assert_eq!(seen.body, upload);

    endpoint.close(0u32.into(), b"done");
    rig.tunnel.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_proxy_that_is_down_gives_502() {
    let ca = TestCa::new("Wirepane Test CA");
    let rig = rig(&ca, false).await;
    // Nothing listens there any more.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    *rig.gateway.lock().unwrap().shared.socks.lock().unwrap() = closed.to_string();
    let (endpoint, mut client) = connect(rig.tunnel_addr, ca.der()).await.unwrap();
    let (response, body) = timeout(Duration::from_secs(20), fetch(&mut client, "GET", "/hello", None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 502);
    assert!(String::from_utf8_lossy(&body).contains("SOCKS"), "{}", String::from_utf8_lossy(&body));
    endpoint.close(0u32.into(), b"done");
    rig.tunnel.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_the_proxy_passes_through_falls_back_to_tcp() {
    let ca = TestCa::new("Wirepane Test CA");
    let real_server = TestCa::new("Some Public CA");
    let mut rig = rig_with(&ca, &real_server, false).await;
    let (endpoint, mut client) = connect(rig.tunnel_addr, ca.der()).await.unwrap();
    let result = timeout(Duration::from_secs(10), fetch(&mut client, "GET", "/hello", None)).await.unwrap();
    assert!(result.is_err(), "rejected (so the phone retries), not answered: {result:?}");
    assert!(rig.gateway.lock().unwrap().shared.passthrough.contains(HOST));
    // The next connection to that host is refused at the handshake: the phone goes to TCP.
    assert!(connect(rig.tunnel_addr, ca.der()).await.is_err());
    assert!(rig.seen.try_recv().is_err(), "no request was replayed");
    endpoint.close(0u32.into(), b"done");
    rig.tunnel.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_phone_without_the_ca_gets_no_connection() {
    let ca = TestCa::new("Wirepane Test CA");
    let other = TestCa::new("Some Other CA");
    let mut rig = rig(&ca, false).await;
    let result = connect(rig.tunnel_addr, other.der()).await;
    assert!(result.is_err(), "the handshake must fail when the CA isn't trusted");
    assert!(rig.seen.try_recv().is_err(), "nothing reaches the proxy");
    rig.tunnel.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn garbage_datagrams_are_dropped_and_the_gateway_keeps_working() {
    let ca = TestCa::new("Wirepane Test CA");
    let mut rig = rig(&ca, false).await;
    let phone: SocketAddr = format!("{PHONE}:40000").parse().unwrap();
    let server: SocketAddr = SERVER.parse().unwrap();
    let mut random = vec![0u8; 1500];
    getrandom::getrandom(&mut random).unwrap();
    // A long header with an unknown version (asks for version negotiation), long and short
    // headers with junk after them, truncated packets, an empty datagram, plain noise.
    let mut unknown_version = vec![0xC0, 0x1A, 0x2A, 0x3A, 0x4A, 8, 1, 2, 3, 4, 5, 6, 7, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9];
    unknown_version.resize(1200, 0);
    let mut v1_junk = vec![0xC0, 0, 0, 0, 1, 8, 1, 2, 3, 4, 5, 6, 7, 8, 0];
    v1_junk.extend_from_slice(&random[..1185]);
    let mut short_junk = vec![0x40];
    short_junk.extend_from_slice(&random[..100]);
    let inputs: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0xFF],
        vec![0xC0, 0, 0],
        random[..20].to_vec(),
        random.clone(),
        unknown_version,
        v1_junk,
        short_junk,
    ];
    for _ in 0..50 {
        for input in &inputs {
            let _ = rig.gateway.lock().unwrap().on_datagram("p1", phone, server, input, Instant::now());
        }
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = rig.gateway.lock().unwrap().poll(Instant::now());

    // Still serves a real phone afterwards.
    let (endpoint, mut client) = connect(rig.tunnel_addr, ca.der()).await.unwrap();
    let (response, body) = timeout(Duration::from_secs(10), fetch(&mut client, "GET", "/hello", None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(body, b"hello over h3");
    next_seen(&mut rig.seen).await;
    endpoint.close(0u32.into(), b"done");
    rig.tunnel.abort();
}

#[test]
fn the_socket_queues_are_bounded() {
    let socket = VirtualSocket::default();
    let phone: SocketAddr = format!("{PHONE}:40000").parse().unwrap();
    let server: SocketAddr = SERVER.parse().unwrap();
    for _ in 0..MAX_INBOUND + 10 {
        socket.push_inbound(phone, server, &[0u8; 1200]);
    }
    let (inbound, _, dropped_in, _) = socket.queued();
    assert_eq!((inbound, dropped_in), (MAX_INBOUND, 10));

    use quinn::AsyncUdpSocket;
    let contents = [0u8; 1200];
    for _ in 0..MAX_OUTBOUND + 5 {
        let transmit = quinn::udp::Transmit {
            destination: phone,
            ecn: None,
            contents: &contents,
            segment_size: None,
            src_ip: Some(server.ip()),
        };
        socket.try_send(&transmit).unwrap();
    }
    let (_, outbound, _, dropped_out) = socket.queued();
    assert_eq!((outbound, dropped_out), (MAX_OUTBOUND, 5));
    let taken = socket.take_outbound();
    assert_eq!(taken.len(), MAX_OUTBOUND);
    assert_eq!(taken[0].0, server, "from the port the phone dialled");
    assert!(!socket.has_outbound());
}

#[test]
fn leaves_are_cached_per_name_and_chain_to_the_ca() {
    let ca = TestCa::new("Wirepane Test CA");
    let issuer = LeafIssuer::new(&ca.cert_pem, &ca.key_pem).unwrap();
    let first = issuer.leaf_for("Example.Test.").unwrap();
    let again = issuer.leaf_for("example.test").unwrap();
    assert!(Arc::ptr_eq(&first, &again));
    let other = issuer.leaf_for("other.test").unwrap();
    assert_ne!(first.cert[0], other.cert[0]);
    issuer.leaf_for("93.184.216.34").unwrap();
    assert!(issuer.leaf_for("bad name!").is_err());
    verify_leaf(&ca.der(), &first.cert[0], HOST);
}

fn verify_leaf(ca: &CertificateDer<'static>, leaf: &CertificateDer<'static>, name: &str) {
    use rustls::client::danger::ServerCertVerifier;
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca.clone()).unwrap();
    let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), certs::provider())
        .build()
        .unwrap();
    let name = rustls::pki_types::ServerName::try_from(name.to_string()).unwrap();
    verifier
        .verify_server_cert(leaf, &[], &name, &[], rustls::pki_types::UnixTime::now())
        .expect("the leaf chains to the CA");
}

/// The real Wirepane CA is RSA 2048 in PKCS#8 PEM (Mockttp's `generateCACertificate`). Run with a
/// throwaway CA of the same kind: `WIREPANE_H3_TEST_CA=<dir with ca.pem and ca.key> cargo test
/// rsa_ca -- --ignored`.
#[test]
#[ignore = "needs WIREPANE_H3_TEST_CA"]
fn signs_with_an_rsa_ca_like_the_wirepane_one() {
    let dir = std::env::var("WIREPANE_H3_TEST_CA").expect("WIREPANE_H3_TEST_CA");
    let cert_pem = std::fs::read_to_string(format!("{dir}/ca.pem")).unwrap();
    let key_pem = std::fs::read_to_string(format!("{dir}/ca.key")).unwrap();
    let issuer = LeafIssuer::new(&cert_pem, &key_pem).unwrap();
    let leaf = issuer.leaf_for(HOST).unwrap();
    let ca = CertificateDer::from_pem_slice(cert_pem.as_bytes()).unwrap();
    verify_leaf(&ca, &leaf.cert[0], HOST);
}

/// The same round trip against a real Mockttp (httptoolkit-server's copy) with SOCKS
/// custom-metadata and a mock rule for https://example.test/hello. Start it with
/// `node mockttp-h3.cjs <dir>` (see `docs/http3.md`), then:
/// `WIREPANE_H3_MOCKTTP=127.0.0.1:<port> WIREPANE_H3_TEST_CA=<dir> cargo test real_mockttp -- --ignored`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a running Mockttp: WIREPANE_H3_MOCKTTP and WIREPANE_H3_TEST_CA"]
async fn real_mockttp_round_trip() {
    let proxy = std::env::var("WIREPANE_H3_MOCKTTP").expect("WIREPANE_H3_MOCKTTP");
    let dir = std::env::var("WIREPANE_H3_TEST_CA").expect("WIREPANE_H3_TEST_CA");
    let cert_pem = std::fs::read_to_string(format!("{dir}/ca.pem")).unwrap();
    let key_pem = std::fs::read_to_string(format!("{dir}/ca.key")).unwrap();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let errors = errors.clone();
        EventSink::from_fn(move |event| errors.lock().unwrap().push(event))
    };
    let gateway = QuicGateway::new(&cert_pem, &key_pem, Arc::new(Mutex::new(proxy)), sink).unwrap();
    let gateway = Arc::new(Mutex::new(gateway));
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let tunnel_addr = socket.local_addr().unwrap();
    let tunnel = start_tunnel(gateway, socket, false);
    let ca = CertificateDer::from_pem_slice(cert_pem.as_bytes()).unwrap();
    let (endpoint, mut client) = connect(tunnel_addr, ca).await.unwrap();

    let (response, body) = timeout(Duration::from_secs(10), fetch(&mut client, "GET", "/hello", None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 200, "{}", String::from_utf8_lossy(&body));
    assert_eq!(body, b"hello from mockttp");
    assert_eq!(response.headers()["x-mockttp"], "yes");

    let upload = vec![b'x'; 20_000];
    let (response, body) = timeout(Duration::from_secs(10), fetch(&mut client, "POST", "/echo", Some(upload)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 200, "{}", String::from_utf8_lossy(&body));
    assert_eq!(body, b"echo 20000 bytes");

    endpoint.close(0u32.into(), b"done");
    tunnel.abort();
    assert!(errors.lock().unwrap().is_empty(), "{:?}", errors.lock().unwrap());
}
