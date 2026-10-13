//! The phone's HTTP/3 connections, one tokio task each, and every request on them replayed to
//! Mockttp as HTTP/1.1: SOCKS5 with the VPN tags, CONNECT to the server the phone dialled, TLS
//! (Mockttp presents a Wirepane CA certificate for the host), then the request. The answer goes
//! back to the phone over HTTP/3. Bodies stream both ways in small pieces; nothing is buffered
//! whole.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use bytes::{Buf, Bytes};
use http::header::{CONTENT_LENGTH, COOKIE, HOST, TRANSFER_ENCODING};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio::time::timeout;

use crate::core::socks::{self, Target};
use crate::events::EventSink;
use crate::frontend::wireguard::lock;

use super::certs::{self, LeafIssuer, PassthroughHosts};
use super::socket::VirtualSocket;

/// Open QUIC connections, all phones together. Beyond it new ones are refused.
pub const MAX_CONNECTIONS: usize = 128;
/// Requests being forwarded at once, all phones together (each holds one connection to Mockttp).
pub const MAX_REQUESTS: usize = 128;
/// Concurrent requests (bidirectional streams) a phone may open on one connection.
pub const MAX_STREAMS_PER_CONNECTION: u32 = 64;
/// A connection with no packets for this long is closed (the phone may ask for less).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_TIMEOUT: Duration = Duration::from_secs(10);
/// A request waits this long for a free slot under `MAX_REQUESTS`, then gets a 503.
const QUEUE_TIMEOUT: Duration = Duration::from_secs(10);
/// Mockttp may wait for a slow server, so the answer's head gets a generous limit...
const RESPONSE_HEAD_TIMEOUT: Duration = Duration::from_secs(120);
/// ...and a body may stream for any length of time, as long as it never stalls this long.
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_HEADERS: usize = 256;
const MAX_LINE_BYTES: usize = 8 * 1024;
const READ_CHUNK: usize = 32 * 1024;

/// What every connection task shares with the gateway.
pub struct Shared {
    pub issuer: Arc<LeafIssuer>,
    pub socks: Arc<Mutex<String>>,
    pub events: EventSink,
    pub transport: Arc<quinn::TransportConfig>,
    pub proxy_tls: tokio_rustls::TlsConnector,
    pub socket: Arc<VirtualSocket>,
    pub passthrough: Arc<PassthroughHosts>,
    /// Tunnel address -> peer id, learnt from `on_datagram`.
    pub peers: Mutex<HashMap<IpAddr, String>>,
    pub requests: Arc<Semaphore>,
}

impl Shared {
    pub fn remember_peer(&self, ip: IpAddr, peer: &str) {
        let mut peers = lock(&self.peers);
        if peers.get(&ip).is_some_and(|known| known == peer) {
            return;
        }
        if peers.len() >= 4096 {
            peers.clear();
        }
        peers.insert(ip, peer.to_string());
    }

    fn peer_for(&self, ip: IpAddr) -> Option<String> {
        lock(&self.peers).get(&ip).cloned()
    }
}

pub fn transport_config() -> quinn::TransportConfig {
    let mut transport = quinn::TransportConfig::default();
    transport.max_idle_timeout(IDLE_TIMEOUT.try_into().ok());
    transport.max_concurrent_bidi_streams(MAX_STREAMS_PER_CONNECTION.into());
    // HTTP/3 needs 3 from the phone (control, QPACK encoder and decoder); some send a few more.
    transport.max_concurrent_uni_streams(16u32.into());
    // Bounded windows bound memory: at most this much unread data per stream and per connection.
    // With MAX_CONNECTIONS that is at most 128 MB each way, all phones together.
    transport.stream_receive_window((256u32 * 1024).into());
    transport.receive_window((1024u32 * 1024).into());
    transport.send_window(1024 * 1024);
    transport.datagram_receive_buffer_size(None);
    // Datagrams stay at 1200 bytes: they always fit the tunnel's MTU, so no path MTU probing.
    transport.initial_mtu(1200);
    transport.mtu_discovery_config(None);
    transport
}

/// Takes the phone's new connections until the endpoint closes.
pub async fn accept_loop(endpoint: quinn::Endpoint, shared: Arc<Shared>) {
    while let Some(incoming) = endpoint.accept().await {
        if endpoint.open_connections() > MAX_CONNECTIONS {
            log::debug!("HTTP/3: too many connections, refusing {}", incoming.remote_address());
            incoming.refuse();
            continue;
        }
        tokio::spawn(serve_connection(incoming, shared.clone()));
    }
}

/// One phone connection: what every request on it needs to know.
struct ConnectionInfo {
    shared: Arc<Shared>,
    connection: quinn::Connection,
    peer: String,
    /// The server the phone dialled (it is where Mockttp connects to).
    dst: SocketAddr,
    sni: Option<String>,
}

async fn serve_connection(incoming: quinn::Incoming, shared: Arc<Shared>) {
    let remote = incoming.remote_address();
    let Some(local_ip) = incoming.local_ip() else {
        incoming.ignore();
        return;
    };
    let dst = SocketAddr::new(local_ip, shared.socket.port_for(remote, local_ip));
    let Some(peer) = shared.peer_for(remote.ip()) else {
        incoming.ignore();
        return;
    };
    let config = match certs::quic_server_config(
        shared.issuer.clone(),
        Some(local_ip),
        shared.passthrough.clone(),
        shared.transport.clone(),
    ) {
        Ok(config) => Arc::new(config),
        Err(error) => {
            log::warn!("HTTP/3: {error:#}");
            incoming.refuse();
            return;
        }
    };
    let connecting = match incoming.accept_with(config) {
        Ok(connecting) => connecting,
        Err(error) => {
            log::debug!("HTTP/3: {remote} -> {dst}: {error}");
            return;
        }
    };
    let connection = match timeout(HANDSHAKE_TIMEOUT, connecting).await {
        Ok(Ok(connection)) => connection,
        Ok(Err(error)) => {
            // Most often the phone does not trust the Wirepane CA (yet).
            log::debug!("HTTP/3: handshake {remote} -> {dst} failed: {error}");
            return;
        }
        Err(_) => {
            log::debug!("HTTP/3: handshake {remote} -> {dst} timed out");
            return;
        }
    };
    let sni = connection
        .handshake_data()
        .and_then(|data| data.downcast::<quinn::crypto::rustls::HandshakeData>().ok())
        .and_then(|data| data.server_name);
    log::debug!("HTTP/3: {peer} {remote} -> {dst} ({sni:?}) connected");
    let info = Arc::new(ConnectionInfo { shared, connection: connection.clone(), peer, dst, sni });

    let mut h3 = match h3::server::builder()
        .max_field_section_size(MAX_HEADER_BYTES as u64)
        .build::<_, Bytes>(h3_quinn::Connection::new(connection))
        .await
    {
        Ok(h3) => h3,
        Err(error) => {
            log::debug!("HTTP/3: {remote} -> {dst}: no HTTP/3 session: {error}");
            return;
        }
    };
    loop {
        match h3.accept().await {
            Ok(Some(resolver)) => {
                tokio::spawn(serve_request(resolver, info.clone()));
            }
            Ok(None) => break,
            Err(error) => {
                if !error.is_h3_no_error() {
                    log::debug!("HTTP/3: {remote} -> {dst} ended: {error}");
                }
                break;
            }
        }
    }
}

type Resolver = h3::server::RequestResolver<h3_quinn::Connection, Bytes>;
type H3Send = h3::server::RequestStream<h3_quinn::SendStream<Bytes>, Bytes>;
type H3Recv = h3::server::RequestStream<h3_quinn::RecvStream, Bytes>;

async fn serve_request(resolver: Resolver, info: Arc<ConnectionInfo>) {
    let (request, stream) = match resolver.resolve_request().await {
        Ok(request) => request,
        Err(error) => {
            log::debug!("HTTP/3: bad request from {}: {error}", info.peer);
            return;
        }
    };
    let (mut send, mut recv) = stream.split();
    let permit = match timeout(QUEUE_TIMEOUT, info.shared.requests.clone().acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        _ => {
            send_error(&mut send, StatusCode::SERVICE_UNAVAILABLE, "Wirepane: too many HTTP/3 requests at once").await;
            return;
        }
    };
    let mut head_sent = false;
    let what = format!("{} {}", request.method(), request.uri());
    if let Err(error) = forward(&info, request, &mut send, &mut recv, &mut head_sent).await {
        log::debug!("HTTP/3: {what} failed: {error:#}");
        if let Some(PassedThrough(host)) = error.downcast_ref::<PassedThrough>() {
            // Not processed, so the phone may retry it; on a new connection, whose handshake
            // is now refused, which sends it to TCP.
            info.shared.passthrough.insert(host);
            send.stop_stream(h3::error::Code::H3_REQUEST_REJECTED);
            recv.stop_sending(h3::error::Code::H3_REQUEST_REJECTED);
            info.connection.close(
                u64::from(h3::error::Code::H3_REQUEST_REJECTED).try_into().unwrap_or(0u32.into()),
                b"passed through by the proxy, use TCP",
            );
        } else if head_sent {
            // The phone already has a status line; a reset tells it the body is incomplete.
            send.stop_stream(h3::error::Code::H3_INTERNAL_ERROR);
        } else {
            let message = format!("Wirepane could not forward this HTTP/3 request: {error:#}");
            send_error(&mut send, StatusCode::BAD_GATEWAY, &message).await;
        }
    }
    drop(permit);
}

async fn send_error(send: &mut H3Send, status: StatusCode, message: &str) {
    let mut response = http::Response::new(());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(http::header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    if send.send_response(response).await.is_ok()
        && send.send_data(Bytes::from(format!("{message}\n"))).await.is_ok()
    {
        send.finish().await.ok();
    }
}

/// Mockttp answered the TLS hop with a certificate that isn't from the Wirepane CA: it passes
/// this host through to the real server (see `PassthroughHosts`).
#[derive(Debug)]
struct PassedThrough(String);

impl std::fmt::Display for PassedThrough {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the proxy passes {} through untouched", self.0)
    }
}

impl std::error::Error for PassedThrough {}

fn is_certificate_error(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
        .is_some_and(|tls| matches!(tls, rustls::Error::InvalidCertificate(_)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    None,
    Length(u64),
    Chunked,
    UntilClose,
}

/// Headers that only mean something on one HTTP/1.1 hop, never copied between the two sides.
fn is_hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-connection" | "transfer-encoding" | "upgrade" | "te"
    )
}

async fn recv_chunk(recv: &mut H3Recv) -> Result<Option<Bytes>> {
    match recv.recv_data().await.context("reading the request body")? {
        Some(mut data) => Ok(Some(data.copy_to_bytes(data.remaining()))),
        None => Ok(None),
    }
}

async fn forward(
    info: &ConnectionInfo,
    request: http::Request<()>,
    send: &mut H3Send,
    recv: &mut H3Recv,
    head_sent: &mut bool,
) -> Result<()> {
    let (parts, ()) = request.into_parts();
    if parts.method == Method::CONNECT {
        bail!("CONNECT over HTTP/3 (WebTransport, MASQUE) can't be replayed as HTTP/1.1");
    }
    let authority = parts
        .uri
        .authority()
        .map(|authority| authority.as_str().to_string())
        .or_else(|| parts.headers.get(HOST).and_then(|host| host.to_str().ok()).map(String::from))
        .ok_or_else(|| anyhow!("the request has no :authority"))?;
    let host = parts
        .uri
        .host()
        .map(|host| host.trim_start_matches('[').trim_end_matches(']').to_string())
        .unwrap_or_else(|| authority.clone());
    let path = parts.uri.path_and_query().map_or("/", |path| path.as_str());
    check_request_target(&parts.method, path)?;

    // A body with a declared length is sent as it is; one without is sent chunked. A request whose
    // stream ends right after its headers has none.
    let declared = match parts.headers.get(CONTENT_LENGTH) {
        Some(value) => Some(
            value
                .to_str()
                .ok()
                .and_then(|text| text.trim().parse::<u64>().ok())
                .ok_or_else(|| anyhow!("bad content-length"))?,
        ),
        None => None,
    };
    let mut first_chunk = None;
    let framing = match declared {
        Some(length) => Framing::Length(length),
        None => {
            first_chunk = recv_chunk(recv).await?;
            if first_chunk.is_some() { Framing::Chunked } else { Framing::None }
        }
    };
    let head = request_head(&parts.method, path, &authority, &parts.headers, framing);

    let sni = info.sni.clone().unwrap_or(host);
    let mut tags = vec![
        "wirepane-vpn".to_string(),
        format!("wirepane-vpn-peer:{}", info.peer),
        "wirepane-vpn-h3".to_string(),
    ];
    if let Some(name) = &info.sni {
        tags.push(format!("wirepane-vpn-sni:{name}"));
    }
    let proxy = lock(&info.shared.socks).clone();
    let upstream = socks::connect(&proxy, &tags, &Target::Ip(info.dst))
        .await
        .with_context(|| format!("SOCKS to the proxy at {proxy}"))?;
    let server_name =
        ServerName::try_from(sni.clone()).map_err(|_| anyhow!("{sni:?} is not a server name"))?;
    let tls = match timeout(TLS_TIMEOUT, info.shared.proxy_tls.connect(server_name, upstream)).await {
        Err(_) => bail!("TLS to the proxy timed out"),
        Ok(Err(error)) if is_certificate_error(&error) => return Err(PassedThrough(sni).into()),
        Ok(Err(error)) => return Err(anyhow::Error::from(error).context("TLS to the proxy")),
        Ok(Ok(tls)) => tls,
    };
    let (mut reader, mut writer) = tokio::io::split(tls);
    writer.write_all(&head).await.context("writing to the proxy")?;
    if framing == Framing::None {
        writer.flush().await?;
    }

    let (result, upload_done) = {
        let upload = upload_body(recv, &mut writer, framing, first_chunk);
        let download = download(&parts.method, &mut reader, send, head_sent);
        tokio::pin!(upload, download);
        let mut upload_done = framing == Framing::None;
        let result = loop {
            tokio::select! {
                uploaded = &mut upload, if !upload_done => match uploaded {
                    Ok(()) => upload_done = true,
                    Err(error) => break Err(error),
                },
                downloaded = &mut download => break downloaded,
            }
        };
        (result, upload_done)
    };
    if !upload_done {
        // The answer is complete (an early 413, say); the rest of the upload isn't wanted.
        recv.stop_sending(h3::error::Code::H3_NO_ERROR);
    }
    result
}

/// The phone's `:path` goes into the HTTP/1.1 request line as it is, so it has to be a path (or `*`
/// for OPTIONS). Mockttp follows an absolute URL in a request line wherever it points, which would
/// let a phone send its request anywhere (the Mac's own services included) instead of to the server
/// it dialled. The `http` crate refuses such a `:path` since 1.5, but 1.4 did not.
fn check_request_target(method: &Method, path: &str) -> Result<()> {
    if path.starts_with('/') || (path == "*" && *method == Method::OPTIONS) {
        return Ok(());
    }
    bail!("the request target must be a path, not {path:?}")
}

fn request_head(
    method: &Method,
    path: &str,
    authority: &str,
    headers: &HeaderMap,
    framing: Framing,
) -> Vec<u8> {
    let mut head = Vec::with_capacity(512);
    head.extend_from_slice(format!("{method} {path} HTTP/1.1\r\nhost: {authority}\r\n").as_bytes());
    let mut cookies: Vec<&[u8]> = Vec::new();
    for (name, value) in headers {
        if name == HOST || is_hop_header(name) {
            continue;
        }
        if name == COOKIE {
            // HTTP/3 may split cookies into several fields; HTTP/1.1 wants one line.
            cookies.push(value.as_bytes());
            continue;
        }
        if name == CONTENT_LENGTH {
            // Written once below, from the value the body is checked against.
            continue;
        }
        head.extend_from_slice(name.as_str().as_bytes());
        head.extend_from_slice(b": ");
        head.extend_from_slice(value.as_bytes());
        head.extend_from_slice(b"\r\n");
    }
    if !cookies.is_empty() {
        head.extend_from_slice(b"cookie: ");
        head.extend_from_slice(&cookies.join(&b"; "[..]));
        head.extend_from_slice(b"\r\n");
    }
    match framing {
        Framing::Chunked => head.extend_from_slice(b"transfer-encoding: chunked\r\n"),
        Framing::Length(length) => head.extend_from_slice(format!("content-length: {length}\r\n").as_bytes()),
        Framing::None if matches!(*method, Method::POST | Method::PUT | Method::PATCH) => {
            head.extend_from_slice(b"content-length: 0\r\n")
        }
        _ => {}
    }
    head.extend_from_slice(b"\r\n");
    head
}

async fn upload_body<W: AsyncWrite + Unpin>(
    recv: &mut H3Recv,
    writer: &mut W,
    framing: Framing,
    mut first_chunk: Option<Bytes>,
) -> Result<()> {
    match framing {
        Framing::None | Framing::UntilClose => {}
        Framing::Length(mut left) => {
            while let Some(chunk) = recv_chunk(recv).await? {
                let len = chunk.len() as u64;
                if len > left {
                    bail!("the request body is longer than its content-length");
                }
                left -= len;
                writer.write_all(&chunk).await?;
                writer.flush().await?;
            }
            if left != 0 {
                bail!("the request body is shorter than its content-length");
            }
        }
        Framing::Chunked => {
            loop {
                let chunk = match first_chunk.take() {
                    Some(chunk) => chunk,
                    None => match recv_chunk(recv).await? {
                        Some(chunk) => chunk,
                        None => break,
                    },
                };
                if chunk.is_empty() {
                    continue;
                }
                writer.write_all(format!("{:x}\r\n", chunk.len()).as_bytes()).await?;
                writer.write_all(&chunk).await?;
                writer.write_all(b"\r\n").await?;
                writer.flush().await?;
            }
            writer.write_all(b"0\r\n\r\n").await?;
        }
    }
    writer.flush().await?;
    Ok(())
}

/// Reads Mockttp's HTTP/1.1 answer and passes it on as the HTTP/3 response.
async fn download<R: AsyncRead + Unpin>(
    method: &Method,
    reader: &mut R,
    send: &mut H3Send,
    head_sent: &mut bool,
) -> Result<()> {
    let mut body = BodyReader { reader, buffer: Vec::with_capacity(READ_CHUNK) };
    let (status, headers) = timeout(RESPONSE_HEAD_TIMEOUT, async {
        loop {
            let (status, headers) = body.read_head().await?;
            // Interim answers (100 Continue, 103 Early Hints) aren't passed on, only the final one.
            match status {
                101 => bail!("the proxy switched protocols, which HTTP/3 can't carry"),
                100..=199 => continue,
                _ => return Ok((status, headers)),
            }
        }
    })
    .await
    .map_err(|_| anyhow!("no answer from the proxy within {RESPONSE_HEAD_TIMEOUT:?}"))??;

    let framing = response_framing(method, status, &headers)?;
    let mut response = http::Response::new(());
    *response.status_mut() = StatusCode::from_u16(status).context("bad status code")?;
    let dropped: Vec<String> = headers
        .get_all(http::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .collect();
    for (name, value) in &headers {
        if is_hop_header(name) || dropped.iter().any(|dropped| dropped == name.as_str()) {
            continue;
        }
        // With both, chunked framing wins (RFC 9112) and the length is meaningless.
        if framing == Framing::Chunked && name == CONTENT_LENGTH {
            continue;
        }
        response.headers_mut().append(name.clone(), value.clone());
    }
    send.send_response(response).await.context("sending the response head")?;
    *head_sent = true;

    match framing {
        Framing::None => {}
        Framing::Length(length) => body.copy_exact(length, send).await?,
        Framing::Chunked => body.copy_chunked(send).await?,
        Framing::UntilClose => body.copy_until_close(send).await?,
    }
    send.finish().await.context("finishing the response")?;
    Ok(())
}

fn response_framing(method: &Method, status: u16, headers: &HeaderMap) -> Result<Framing> {
    if *method == Method::HEAD || status == 204 || status == 304 {
        return Ok(Framing::None);
    }
    let chunked = headers
        .get_all(TRANSFER_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.to_ascii_lowercase().contains("chunked"));
    if chunked {
        return Ok(Framing::Chunked);
    }
    match headers.get(CONTENT_LENGTH) {
        Some(value) => value
            .to_str()
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok())
            .map(Framing::Length)
            .ok_or_else(|| anyhow!("the proxy sent a bad content-length")),
        None => Ok(Framing::UntilClose),
    }
}

/// Reads an HTTP/1.1 message from Mockttp with a small look-ahead buffer.
struct BodyReader<'a, R> {
    reader: &'a mut R,
    buffer: Vec<u8>,
}

impl<R: AsyncRead + Unpin> BodyReader<'_, R> {
    /// Reads more into the buffer. False at the end of the stream.
    async fn fill(&mut self) -> Result<bool> {
        let mut chunk = vec![0u8; READ_CHUNK];
        let read = timeout(BODY_IDLE_TIMEOUT, self.reader.read(&mut chunk))
            .await
            .map_err(|_| anyhow!("the proxy went quiet for {BODY_IDLE_TIMEOUT:?}"))?
            .context("reading from the proxy")?;
        self.buffer.extend_from_slice(&chunk[..read]);
        Ok(read > 0)
    }

    async fn read_head(&mut self) -> Result<(u16, HeaderMap)> {
        loop {
            let mut slots = [httparse::EMPTY_HEADER; MAX_RESPONSE_HEADERS];
            let mut parsed = httparse::Response::new(&mut slots);
            match parsed.parse(&self.buffer).context("the proxy's answer is not HTTP/1.1")? {
                httparse::Status::Complete(used) => {
                    let status = parsed.code.ok_or_else(|| anyhow!("no status code"))?;
                    let mut headers = HeaderMap::new();
                    for header in parsed.headers.iter() {
                        let (Ok(name), Ok(value)) = (
                            HeaderName::from_bytes(header.name.as_bytes()),
                            HeaderValue::from_bytes(header.value),
                        ) else {
                            continue;
                        };
                        headers.append(name, value);
                    }
                    self.buffer.drain(..used);
                    return Ok((status, headers));
                }
                httparse::Status::Partial => {
                    if self.buffer.len() > MAX_HEADER_BYTES {
                        bail!("the proxy's response head is too large");
                    }
                    if !self.fill().await? {
                        bail!("the proxy closed the connection before answering");
                    }
                }
            }
        }
    }

    async fn read_line(&mut self) -> Result<Vec<u8>> {
        loop {
            if let Some(end) = self.buffer.windows(2).position(|pair| pair == b"\r\n") {
                let line = self.buffer[..end].to_vec();
                self.buffer.drain(..end + 2);
                return Ok(line);
            }
            if self.buffer.len() > MAX_LINE_BYTES {
                bail!("a chunk line from the proxy is too long");
            }
            if !self.fill().await? {
                bail!("the proxy closed the connection in the middle of a chunked body");
            }
        }
    }

    async fn copy_exact(&mut self, mut left: u64, send: &mut H3Send) -> Result<()> {
        while left > 0 {
            if self.buffer.is_empty() && !self.fill().await? {
                bail!("the proxy closed the connection {left} bytes before the end of the body");
            }
            let take = (left.min(self.buffer.len() as u64)) as usize;
            let piece: Vec<u8> = self.buffer.drain(..take).collect();
            left -= take as u64;
            send.send_data(Bytes::from(piece)).await.context("sending the body")?;
        }
        Ok(())
    }

    async fn copy_chunked(&mut self, send: &mut H3Send) -> Result<()> {
        loop {
            let line = self.read_line().await?;
            let size_text = std::str::from_utf8(&line)
                .ok()
                .and_then(|line| line.split(';').next())
                .map(str::trim)
                .unwrap_or_default();
            let size = u64::from_str_radix(size_text, 16)
                .map_err(|_| anyhow!("bad chunk size from the proxy"))?;
            if size == 0 {
                // Trailers, if any, end with an empty line; they aren't passed on.
                while !self.read_line().await?.is_empty() {}
                return Ok(());
            }
            self.copy_exact(size, send).await?;
            if !self.read_line().await?.is_empty() {
                bail!("a chunk from the proxy doesn't end with CRLF");
            }
        }
    }

    async fn copy_until_close(&mut self, send: &mut H3Send) -> Result<()> {
        loop {
            if !self.buffer.is_empty() {
                let piece = std::mem::take(&mut self.buffer);
                send.send_data(Bytes::from(piece)).await.context("sending the body")?;
            }
            if !self.fill().await? {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head_text(method: Method, headers: &[(&str, &str)], framing: Framing) -> String {
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            map.append(HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_str(value).unwrap());
        }
        String::from_utf8(request_head(&method, "/a?b=1", "example.test", &map, framing)).unwrap()
    }

    #[test]
    fn builds_an_http1_head_from_http3_headers() {
        let text = head_text(
            Method::GET,
            &[("user-agent", "t"), ("cookie", "a=1"), ("cookie", "b=2"), ("connection", "x"), ("te", "trailers")],
            Framing::None,
        );
        assert_eq!(text, "GET /a?b=1 HTTP/1.1\r\nhost: example.test\r\nuser-agent: t\r\ncookie: a=1; b=2\r\n\r\n");
    }

    #[test]
    fn only_a_path_is_a_request_target() {
        for path in ["/", "/a?b=1", "/a/b/c?x=y&z", "//double/slash"] {
            assert!(check_request_target(&Method::GET, path).is_ok(), "{path}");
        }
        assert!(check_request_target(&Method::OPTIONS, "*").is_ok(), "OPTIONS * is the one non-path target");
        let not_paths = [
            "http://127.0.0.1:45457/version",
            "https://example.test/",
            "HTTP://x/",
            "example.test:443",
            "a/b",
            "",
            "*",
        ];
        for path in not_paths {
            let error = check_request_target(&Method::GET, path).expect_err(path);
            assert!(error.to_string().contains("must be a path"), "{error}");
        }
        assert!(check_request_target(&Method::POST, "*").is_err(), "* is only for OPTIONS");
        assert!(check_request_target(&Method::OPTIONS, "http://127.0.0.1:9/").is_err());
    }

    #[test]
    fn frames_request_bodies() {
        let chunked = head_text(Method::POST, &[], Framing::Chunked);
        assert!(chunked.ends_with("transfer-encoding: chunked\r\n\r\n"), "{chunked}");
        let empty = head_text(Method::POST, &[], Framing::None);
        assert!(empty.ends_with("content-length: 0\r\n\r\n"), "{empty}");
        let sized = head_text(Method::PUT, &[("content-length", "5"), ("content-length", "7")], Framing::Length(5));
        assert!(sized.ends_with("\r\ncontent-length: 5\r\n\r\n"), "{sized}");
        assert_eq!(sized.matches("content-length").count(), 1, "{sized}");
        assert!(!sized.contains("transfer-encoding"), "{sized}");
    }

    #[test]
    fn picks_the_response_framing() {
        let mut headers = HeaderMap::new();
        assert_eq!(response_framing(&Method::GET, 200, &headers).unwrap(), Framing::UntilClose);
        assert_eq!(response_framing(&Method::HEAD, 200, &headers).unwrap(), Framing::None);
        assert_eq!(response_framing(&Method::GET, 304, &headers).unwrap(), Framing::None);
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("12"));
        assert_eq!(response_framing(&Method::GET, 200, &headers).unwrap(), Framing::Length(12));
        headers.insert(TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
        assert_eq!(response_framing(&Method::GET, 200, &headers).unwrap(), Framing::Chunked);
        headers.remove(TRANSFER_ENCODING);
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("x"));
        assert!(response_framing(&Method::GET, 200, &headers).is_err());
    }
}
