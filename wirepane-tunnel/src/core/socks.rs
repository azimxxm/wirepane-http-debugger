//! SOCKS5 client for Mockttp's proxy port, using the custom-metadata method (0xDA).
//!
//! Wire format (mockttp `socks-server`): greeting `05 01 DA`, server `05 DA`; then a 2-byte
//! big-endian length and the JSON metadata, server `05 00`; then a normal CONNECT request.

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

const SOCKS_TIMEOUT: Duration = Duration::from_secs(10);
const METHOD_CUSTOM_METADATA: u8 = 0xDA;

#[derive(Debug, Clone)]
pub enum Target {
    Ip(SocketAddr),
    Host(String, u16),
}

fn bad(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Opens a SOCKS5 connection to `proxy`, sends the tags and CONNECTs to `target`. The returned
/// stream is ready to carry the tunnelled bytes.
pub async fn connect(proxy: &str, tags: &[String], target: &Target) -> io::Result<TcpStream> {
    match timeout(SOCKS_TIMEOUT, handshake(proxy, tags, target)).await {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "SOCKS handshake timed out",
        )),
    }
}

async fn handshake(proxy: &str, tags: &[String], target: &Target) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect(proxy).await?;
    stream.set_nodelay(true).ok();
    log::trace!("SOCKS: connected to {proxy}");

    // Offer only custom-metadata, so a plain SOCKS server can't silently skip our tags.
    stream.write_all(&[0x05, 0x01, METHOD_CUSTOM_METADATA]).await?;
    let mut choice = [0u8; 2];
    stream.read_exact(&mut choice).await?;
    log::trace!("SOCKS: method answer {choice:02x?}");
    if choice != [0x05, METHOD_CUSTOM_METADATA] {
        return Err(bad(format!(
            "the proxy did not accept custom-metadata (answered {choice:02x?})"
        )));
    }

    let metadata = serde_json::to_vec(&json!({ "tags": tags }))?;
    let length = u16::try_from(metadata.len()).map_err(|_| bad("SOCKS metadata is too long"))?;
    let mut message = Vec::with_capacity(2 + metadata.len());
    message.extend_from_slice(&length.to_be_bytes());
    message.extend_from_slice(&metadata);
    stream.write_all(&message).await?;
    log::trace!("SOCKS: metadata sent");
    stream.read_exact(&mut choice).await?;
    log::trace!("SOCKS: metadata answer {choice:02x?}");
    if choice != [0x05, 0x00] {
        return Err(bad(format!("the proxy rejected the metadata ({choice:02x?})")));
    }

    stream.write_all(&connect_request(target)?).await?;
    log::trace!("SOCKS: connect request sent");
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    log::trace!("SOCKS: connect answer {head:02x?}");
    if head[0] != 0x05 || head[1] != 0x00 {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("SOCKS CONNECT failed with code {}", head[1]),
        ));
    }
    // Skip the bound address; read exactly its length so no tunnelled byte is swallowed.
    let skip = match head[3] {
        0x01 => 4 + 2,
        0x04 => 16 + 2,
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            usize::from(len[0]) + 2
        }
        other => return Err(bad(format!("unknown SOCKS address type {other}"))),
    };
    let mut rest = vec![0u8; skip];
    stream.read_exact(&mut rest).await?;
    Ok(stream)
}

fn connect_request(target: &Target) -> io::Result<Vec<u8>> {
    let mut request = vec![0x05, 0x01, 0x00];
    match target {
        Target::Ip(SocketAddr::V4(addr)) => {
            request.push(0x01);
            request.extend_from_slice(&addr.ip().octets());
            request.extend_from_slice(&addr.port().to_be_bytes());
        }
        Target::Ip(SocketAddr::V6(addr)) => {
            request.push(0x04);
            request.extend_from_slice(&addr.ip().octets());
            request.extend_from_slice(&addr.port().to_be_bytes());
        }
        Target::Host(name, port) => {
            let len = u8::try_from(name.len()).map_err(|_| bad("host name is too long"))?;
            request.push(0x03);
            request.push(len);
            request.extend_from_slice(name.as_bytes());
            request.extend_from_slice(&port.to_be_bytes());
        }
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_ipv4_and_host_requests() {
        let ip = connect_request(&Target::Ip("1.2.3.4:443".parse().unwrap())).unwrap();
        assert_eq!(ip, vec![5, 1, 0, 1, 1, 2, 3, 4, 0x01, 0xBB]);
        let host = connect_request(&Target::Host("wirepane.cert".into(), 80)).unwrap();
        assert_eq!(&host[..5], &[5, 1, 0, 3, 13]);
        assert_eq!(&host[5..18], b"wirepane.cert");
        assert_eq!(&host[18..], &[0, 80]);
    }
}
