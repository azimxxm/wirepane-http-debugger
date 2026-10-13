//! QUIC mode `decrypt` end to end through the real binary: a test phone (boringtun + quinn + h3)
//! dials 93.184.216.34:443 over WireGuard, the sidecar's HTTP/3 gateway terminates it with a leaf
//! from the CA given by `--ca-cert`/`--ca-key`, and the request reaches a stand-in for Mockttp
//! (SOCKS5 custom-metadata, TLS with a certificate from the same CA, HTTP/1.1) with the VPN tags.

mod support;

use std::collections::VecDeque;
use std::fmt;
use std::io::{BufRead, BufReader, IoSliceMut, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::Path;
use std::pin::Pin;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use bytes::Buf;
use rcgen::{BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use support::wg_client::parse_config;

const SERVER: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(93, 184, 216, 34), 443);
const HOST: &str = "example.test";

struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<Value>,
    seen: Vec<Value>,
}

impl Sidecar {
    fn spawn(dir: &Path, socks: SocketAddr) -> Sidecar {
        let mut child = Command::new(env!("CARGO_BIN_EXE_wirepane-tunnel"))
            .args(["--wireguard", "127.0.0.1:0", "--endpoint-host", "127.0.0.1", "--quic", "decrypt"])
            .arg("--socks")
            .arg(socks.to_string())
            .arg("--state")
            .arg(dir.join("state.json"))
            .arg("--ca-cert")
            .arg(dir.join("ca.pem"))
            .arg("--ca-key")
            .arg(dir.join("ca.key"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("cannot start the sidecar");
        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take();
        let (tx, rx) = channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        Sidecar { child, stdin, events: rx, seen: Vec::new() }
    }

    fn wait_for(&mut self, event: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(found) = self.seen.iter().find(|value| value["event"] == event) {
                return found.clone();
            }
            match self.events.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => self.seen.push(value),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => panic!("sidecar output ended while waiting for {event}"),
            }
            assert!(Instant::now() < deadline, "timed out waiting for {event}; saw {:#?}", self.seen);
        }
    }

    fn send(&mut self, command: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{command}").unwrap();
        stdin.flush().unwrap();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stdin.take();
        thread::sleep(Duration::from_millis(50));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The test phone's network: quinn's datagrams become IPv4/UDP packets from the phone's tunnel
/// address, sealed with WireGuard; what comes back is opened and handed to quinn.
struct WgSocket {
    tunn: Mutex<Tunn>,
    udp: std::net::UdpSocket,
    phone: SocketAddrV4,
    /// The one server this test phone talks QUIC to.
    server: SocketAddrV4,
    inbound: Mutex<(VecDeque<Vec<u8>>, Option<Waker>)>,
}

impl fmt::Debug for WgSocket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WgSocket")
    }
}

impl WgSocket {
    /// Opens one datagram from the sidecar; UDP payloads from the server go to quinn.
    fn receive(&self, datagram: &[u8]) {
        let mut buf = vec![0u8; 65535];
        let mut tunn = self.tunn.lock().unwrap();
        let mut result = tunn.decapsulate(None, datagram, &mut buf);
        loop {
            match result {
                TunnResult::WriteToNetwork(reply) => {
                    let _ = self.udp.send(reply);
                    result = tunn.decapsulate(None, &[], &mut buf);
                }
                TunnResult::WriteToTunnelV4(packet, _) => {
                    // IPv4 + UDP from the server to the phone: hand the payload to quinn.
                    if packet.len() >= 28 && packet[9] == 17 {
                        let header = usize::from(packet[0] & 0x0f) * 4;
                        let payload = packet[header + 8..].to_vec();
                        let waker = {
                            let mut inbound = self.inbound.lock().unwrap();
                            inbound.0.push_back(payload);
                            inbound.1.take()
                        };
                        if let Some(waker) = waker {
                            waker.wake();
                        }
                    }
                    break;
                }
                _ => break,
            }
        }
    }

    fn tick(&self) {
        let mut buf = vec![0u8; 65535];
        if let TunnResult::WriteToNetwork(packet) = self.tunn.lock().unwrap().update_timers(&mut buf) {
            let _ = self.udp.send(packet);
        }
    }
}

#[derive(Debug)]
struct Writable;

impl quinn::UdpPoller for Writable {
    fn poll_writable(self: Pin<&mut Self>, _cx: &mut Context) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl quinn::AsyncUdpSocket for WgSocket {
    fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn quinn::UdpPoller>> {
        Box::pin(Writable)
    }

    fn try_send(&self, transmit: &quinn::udp::Transmit) -> std::io::Result<()> {
        let packet = wirepane_tunnel::core::icmp::udp_datagram(self.phone, self.server, transmit.contents);
        let mut buf = vec![0u8; 65535];
        if let TunnResult::WriteToNetwork(sealed) = self.tunn.lock().unwrap().encapsulate(&packet, &mut buf) {
            let _ = self.udp.send(sealed);
        }
        Ok(())
    }

    fn poll_recv(
        &self,
        cx: &mut Context,
        bufs: &mut [IoSliceMut<'_>],
        meta: &mut [quinn::udp::RecvMeta],
    ) -> Poll<std::io::Result<usize>> {
        let mut inbound = self.inbound.lock().unwrap();
        let Some(payload) = inbound.0.pop_front() else {
            inbound.1 = Some(cx.waker().clone());
            return Poll::Pending;
        };
        let len = payload.len().min(bufs[0].len());
        bufs[0][..len].copy_from_slice(&payload[..len]);
        meta[0].addr = SocketAddr::V4(self.server);
        meta[0].len = len;
        meta[0].stride = len;
        meta[0].ecn = None;
        meta[0].dst_ip = None;
        Poll::Ready(Ok(1))
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        Ok(SocketAddr::V4(self.phone))
    }
}

/// Completes the WireGuard handshake, then keeps reading the sidecar's datagrams on a thread.
fn start_phone(config_text: &str, server: SocketAddrV4) -> Arc<WgSocket> {
    let config = parse_config(config_text);
    let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    udp.connect(config.endpoint).unwrap();
    udp.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
    let tunn = Tunn::new(
        StaticSecret::from(config.private_key),
        PublicKey::from(config.server_public),
        None,
        Some(25),
        11,
        None,
    );
    let socket = Arc::new(WgSocket {
        tunn: Mutex::new(tunn),
        udp,
        phone: SocketAddrV4::new(config.address, 40001),
        server,
        inbound: Mutex::new((VecDeque::new(), None)),
    });
    let mut buf = vec![0u8; 65535];
    let deadline = Instant::now() + Duration::from_secs(5);
    while socket.tunn.lock().unwrap().time_since_last_handshake().is_none() {
        assert!(Instant::now() < deadline, "no WireGuard handshake");
        if let TunnResult::WriteToNetwork(init) = socket.tunn.lock().unwrap().format_handshake_initiation(&mut buf, false) {
            let _ = socket.udp.send(init);
        }
        let mut datagram = vec![0u8; 65535];
        let wait = Instant::now() + Duration::from_millis(500);
        while Instant::now() < wait && socket.tunn.lock().unwrap().time_since_last_handshake().is_none() {
            if let Ok(len) = socket.udp.recv(&mut datagram) {
                socket.receive(&datagram[..len]);
            }
        }
    }
    let reader = socket.clone();
    thread::spawn(move || {
        let mut datagram = vec![0u8; 65535];
        let mut last_tick = Instant::now();
        // Ends when the test drops the last other handle.
        while Arc::strong_count(&reader) > 1 {
            if let Ok(len) = reader.udp.recv(&mut datagram) {
                reader.receive(&datagram[..len]);
            }
            if last_tick.elapsed() > Duration::from_millis(250) {
                last_tick = Instant::now();
                reader.tick();
            }
        }
    });
    socket
}

fn write_ca(dir: &Path) -> (Issuer<'static, KeyPair>, CertificateDer<'static>) {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::default();
    let mut subject = DistinguishedName::new();
    subject.push(DnType::CommonName, "Wirepane Test CA");
    params.distinguished_name = subject;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::DigitalSignature];
    let cert = params.self_signed(&key).unwrap();
    std::fs::write(dir.join("ca.pem"), cert.pem()).unwrap();
    std::fs::write(dir.join("ca.key"), key.serialize_pem()).unwrap();
    let der = cert.der().clone();
    (Issuer::new(params, key), der)
}

/// SOCKS5 custom-metadata, TLS for example.test from the test CA, one HTTP/1.1 answer. Sends the
/// tags and the request head it saw.
async fn fake_mockttp(issuer: &Issuer<'static, KeyPair>) -> (SocketAddr, mpsc::UnboundedReceiver<(Vec<String>, String)>) {
    let leaf_key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec![HOST.to_string()]).unwrap();
    params.distinguished_name = DistinguishedName::new();
    let leaf = params.signed_by(&leaf_key, issuer).unwrap();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![leaf.der().clone()], key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut greeting = [0u8; 3];
                stream.read_exact(&mut greeting).await.unwrap();
                stream.write_all(&[5, 0xDA]).await.unwrap();
                let mut len = [0u8; 2];
                stream.read_exact(&mut len).await.unwrap();
                let mut metadata = vec![0u8; usize::from(u16::from_be_bytes(len))];
                stream.read_exact(&mut metadata).await.unwrap();
                let metadata: Value = serde_json::from_slice(&metadata).unwrap();
                let tags = metadata["tags"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
                stream.write_all(&[5, 0]).await.unwrap();
                let mut connect = [0u8; 10];
                stream.read_exact(&mut connect).await.unwrap();
                assert_eq!(connect[4..], [93, 184, 216, 34, 1, 187], "CONNECT goes to the server the phone dialled");
                stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                let mut tls = acceptor.accept(stream).await.unwrap();
                let mut head = Vec::new();
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    let mut chunk = [0u8; 2048];
                    let read = tls.read(&mut chunk).await.unwrap();
                    assert!(read > 0);
                    head.extend_from_slice(&chunk[..read]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let path = head.split(' ').nth(1).unwrap_or("/").to_string();
                tx.send((tags, head)).ok();
                let body = match path.strip_prefix("/big/") {
                    Some(size) => vec![b'z'; size.parse().unwrap()],
                    None => b"hello through the tunnel".to_vec(),
                };
                tls.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
                tls.write_all(&body).await.unwrap();
                tls.flush().await.unwrap();
                let _ = tokio::time::timeout(Duration::from_secs(2), tls.read(&mut [0u8; 16])).await;
            });
        }
    });
    (addr, rx)
}

/// The test phone's QUIC client, trusting only `ca` (the phone has the Wirepane CA installed).
fn quic_client(phone: Arc<WgSocket>, ca: CertificateDer<'static>) -> quinn::Endpoint {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"h3".to_vec()];
    let mut client_config =
        quinn::ClientConfig::new(Arc::new(quinn::crypto::rustls::QuicClientConfig::try_from(tls).unwrap()));
    let mut transport = quinn::TransportConfig::default();
    transport.mtu_discovery_config(None);
    client_config.transport_config(Arc::new(transport));
    let mut endpoint = quinn::Endpoint::new_with_abstract_socket(
        quinn::EndpointConfig::default(),
        None,
        phone,
        Arc::new(quinn::TokioRuntime),
    )
    .unwrap();
    endpoint.set_default_client_config(client_config);
    endpoint
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http3_through_the_tunnel_reaches_the_proxy_as_http1() {
    let dir = tempfile::tempdir().unwrap();
    let (issuer, ca_der) = write_ca(dir.path());
    let (proxy, mut seen) = fake_mockttp(&issuer).await;
    let mut sidecar = Sidecar::spawn(dir.path(), proxy);
    let ready = sidecar.wait_for("ready");
    assert_eq!(ready["capabilities"]["quicDecrypt"], true, "{ready}");
    sidecar.send(json!({"cmd": "add-peer", "name": "HTTP/3 test"}));
    let added = sidecar.wait_for("peer-added");
    let phone = start_phone(added["config"].as_str().unwrap(), SERVER);
    let endpoint = quic_client(phone, ca_der);

    let connection = tokio::time::timeout(Duration::from_secs(10), endpoint.connect(SocketAddr::V4(SERVER), HOST).unwrap())
        .await
        .expect("QUIC handshake through the tunnel timed out")
        .expect("QUIC handshake through the tunnel failed");
    let (mut driver, mut client) = h3::client::new(h3_quinn::Connection::new(connection)).await.unwrap();
    tokio::spawn(async move {
        let _ = std::future::poll_fn(|cx| driver.poll_close(cx)).await;
    });
    let request = http::Request::get(format!("https://{HOST}/through-the-tunnel")).body(()).unwrap();
    let started = Instant::now();
    let mut stream = client.send_request(request).await.unwrap();
    stream.finish().await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(10), stream.recv_response()).await.unwrap().unwrap();
    assert_eq!(response.status(), 200);
    let mut body = Vec::new();
    while let Some(mut chunk) = stream.recv_data().await.unwrap() {
        body.extend_from_slice(&chunk.copy_to_bytes(chunk.remaining()));
    }
    assert_eq!(body, b"hello through the tunnel");
    eprintln!("HTTP/3 request through the tunnel took {:?}", started.elapsed());

    let (tags, head) = seen.recv().await.unwrap();
    assert_eq!(tags, ["wirepane-vpn", "wirepane-vpn-peer:p1", "wirepane-vpn-h3", "wirepane-vpn-sni:example.test"]);
    assert!(head.starts_with("GET /through-the-tunnel HTTP/1.1\r\nhost: example.test\r\n"), "{head}");
    assert!(
        sidecar.seen.iter().all(|event| event["event"] != "error"),
        "no error events: {:#?}",
        sidecar.seen
    );
    let quic = sidecar.wait_for("quic");
    assert_eq!(quic["action"], "decrypted", "{quic}");

    // A bigger body on the same connection: flow control and the core's polling keep it moving.
    let size = 4 * 1024 * 1024;
    let request = http::Request::get(format!("https://{HOST}/big/{size}")).body(()).unwrap();
    let started = Instant::now();
    let mut stream = client.send_request(request).await.unwrap();
    stream.finish().await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(10), stream.recv_response()).await.unwrap().unwrap();
    assert_eq!(response.status(), 200);
    let mut received = 0;
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(20), stream.recv_data()).await.unwrap().unwrap() {
        received += chunk.remaining();
    }
    assert_eq!(received, size);
    let elapsed = started.elapsed();
    eprintln!(
        "{} MB over HTTP/3 through the tunnel in {elapsed:?} ({:.1} MB/s)",
        size / (1024 * 1024),
        size as f64 / 1_048_576.0 / elapsed.as_secs_f64()
    );
    seen.recv().await.unwrap();

    endpoint.close(0u32.into(), b"done");
}

/// A real HTTP/3 site through the sidecar and a real Mockttp that passes requests upstream
/// (`node scripts/mockttp-h3.cjs <dir>`, docs/http3.md). Needs the internet:
/// `WIREPANE_H3_MOCKTTP=127.0.0.1:<port> WIREPANE_H3_TEST_CA=<dir> [WIREPANE_H3_SITE=<host>]
/// cargo test --test http3 real_site -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a running Mockttp and the internet: WIREPANE_H3_MOCKTTP, WIREPANE_H3_TEST_CA"]
async fn http3_to_a_real_site_through_mockttp() {
    let proxy: SocketAddr = std::env::var("WIREPANE_H3_MOCKTTP").expect("WIREPANE_H3_MOCKTTP").parse().unwrap();
    let ca_dir = std::path::PathBuf::from(std::env::var("WIREPANE_H3_TEST_CA").expect("WIREPANE_H3_TEST_CA"));
    let site = std::env::var("WIREPANE_H3_SITE").unwrap_or_else(|_| "cloudflare-quic.com".to_string());
    let dir = tempfile::tempdir().unwrap();
    std::fs::copy(ca_dir.join("ca.pem"), dir.path().join("ca.pem")).unwrap();
    std::fs::copy(ca_dir.join("ca.key"), dir.path().join("ca.key")).unwrap();
    let ca = CertificateDer::from_pem_slice(&std::fs::read(ca_dir.join("ca.pem")).unwrap()).unwrap();
    let ip = tokio::net::lookup_host((site.as_str(), 443))
        .await
        .unwrap()
        .find_map(|addr| match addr {
            SocketAddr::V4(v4) => Some(v4),
            SocketAddr::V6(_) => None,
        })
        .expect("an IPv4 address for the site");

    let mut sidecar = Sidecar::spawn(dir.path(), proxy);
    sidecar.wait_for("ready");
    sidecar.send(json!({"cmd": "add-peer", "name": "HTTP/3 real site"}));
    let added = sidecar.wait_for("peer-added");
    let phone = start_phone(added["config"].as_str().unwrap(), ip);
    let endpoint = quic_client(phone, ca);
    let connection = tokio::time::timeout(Duration::from_secs(10), endpoint.connect(SocketAddr::V4(ip), &site).unwrap())
        .await
        .expect("QUIC handshake timed out")
        .expect("QUIC handshake failed");
    let (mut driver, mut client) = h3::client::new(h3_quinn::Connection::new(connection)).await.unwrap();
    tokio::spawn(async move {
        let _ = std::future::poll_fn(|cx| driver.poll_close(cx)).await;
    });
    let request = http::Request::get(format!("https://{site}/")).header("user-agent", "wirepane-h3-test").body(()).unwrap();
    let started = Instant::now();
    let mut stream = client.send_request(request).await.unwrap();
    stream.finish().await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(30), stream.recv_response()).await.unwrap().unwrap();
    let mut size = 0;
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), stream.recv_data()).await.unwrap().unwrap() {
        size += chunk.remaining();
    }
    eprintln!(
        "{site} ({ip}): {} with {size} body bytes in {:?}; server {:?}, alt-svc {:?}",
        response.status(),
        started.elapsed(),
        response.headers().get("server"),
        response.headers().get("alt-svc")
    );
    assert!(response.status().is_success() || response.status().is_redirection(), "{}", response.status());
    endpoint.close(0u32.into(), b"done");
}
