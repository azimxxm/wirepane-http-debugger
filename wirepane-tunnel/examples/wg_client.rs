//! Test helper for the end-to-end script: connects to the sidecar with a wg-quick config file,
//! then optionally resolves a name and/or does an HTTP GET through the tunnel.
//!
//!   wg_client --config <file> [--dns <name>] [--get <ip:port>] [--host <header>] [--path </x>]
//!             [--udp <ip:port> [--payload <text>]] [--hold <seconds>]
//!
//! `--udp` sends one datagram and reports whether an answer came back and which ICMP errors did
//! (UDP/443 gets a port unreachable from the sidecar). `--hold` keeps the tunnel up for that long
//! and reports the keepalives the server sent meanwhile. Prints one JSON line per step.

// The shared test client has more helpers than this example needs.
#[allow(dead_code)]
#[path = "../tests/support/wg_client.rs"]
mod wg_client;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

/// Reads the interesting fields of a raw ICMP packet that came through the tunnel.
fn describe_icmp(packet: &[u8]) -> serde_json::Value {
    let header = usize::from(packet[0] & 0x0F) * 4;
    let (kind, code) = (packet[header], packet[header + 1]);
    // An error quotes the packet that caused it: its IPv4 header, then the first 8 bytes.
    let quote = &packet[header + 8..];
    let quoted_header = usize::from(quote[0] & 0x0F) * 4;
    let quoted_dst = Ipv4Addr::new(quote[16], quote[17], quote[18], quote[19]);
    let quoted_port = u16::from_be_bytes([quote[quoted_header + 2], quote[quoted_header + 3]]);
    serde_json::json!({
        "type": kind,
        "code": code,
        "from": Ipv4Addr::new(packet[12], packet[13], packet[14], packet[15]).to_string(),
        "quotedDst": format!("{quoted_dst}:{quoted_port}"),
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let config_path = value("--config").expect("--config <file> is required");
    let text = std::fs::read_to_string(config_path).expect("cannot read the config file");
    let mut client = wg_client::WgClient::connect(&text).unwrap_or_else(|e| {
        println!("{}", serde_json::json!({ "step": "handshake", "ok": false, "error": e }));
        std::process::exit(2);
    });
    println!("{}", serde_json::json!({ "step": "handshake", "ok": true }));

    if let Some(name) = value("--dns") {
        let answers: Vec<String> = client.dns_a(&name).iter().map(|ip| ip.to_string()).collect();
        println!("{}", serde_json::json!({ "step": "dns", "name": name, "answers": answers }));
    }
    if let Some(target) = value("--get") {
        let addr: SocketAddr = target.parse().expect("--get needs ip:port");
        let std::net::IpAddr::V4(ip) = addr.ip() else {
            panic!("IPv4 only");
        };
        let host = value("--host").unwrap_or_else(|| target.clone());
        let path = value("--path").unwrap_or_else(|| "/".into());
        match client.http_get(ip, addr.port(), &host, &path) {
            Ok(response) => println!(
                "{}",
                serde_json::json!({ "step": "get", "ok": true, "response": response })
            ),
            Err(error) => println!(
                "{}",
                serde_json::json!({ "step": "get", "ok": false, "error": error })
            ),
        }
    }
    if let Some(target) = value("--udp") {
        let addr: SocketAddr = target.parse().expect("--udp needs ip:port");
        let IpAddr::V4(ip) = addr.ip() else {
            panic!("IPv4 only");
        };
        let payload = value("--payload").unwrap_or_else(|| "wirepane example datagram".into());
        let answer = client.udp_exchange(ip, addr.port(), payload.as_bytes(), Duration::from_secs(2));
        client.pump_for(Duration::from_millis(300));
        let icmp: Vec<serde_json::Value> = client.icmp_received.iter().map(|p| describe_icmp(p)).collect();
        println!(
            "{}",
            serde_json::json!({ "step": "udp", "answered": answer.is_some(), "icmp": icmp })
        );
    }
    if let Some(seconds) = value("--hold") {
        let seconds: u64 = seconds.parse().expect("--hold needs seconds");
        client.pump_for(Duration::from_secs(seconds));
        println!(
            "{}",
            serde_json::json!({ "step": "hold", "seconds": seconds, "keepalives": client.keepalives_received })
        );
    }
}
