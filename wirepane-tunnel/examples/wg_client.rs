//! Test helper for the end-to-end script: connects to the sidecar with a wg-quick config file,
//! then optionally resolves a name and/or does an HTTP GET through the tunnel.
//!
//!   wg_client --config <file> [--dns <name>] [--get <ip:port>] [--host <header>] [--path </x>]
//!
//! Prints one JSON line per step.

// The shared test client has more helpers than this example needs.
#[allow(dead_code)]
#[path = "../tests/support/wg_client.rs"]
mod wg_client;

use std::net::SocketAddr;

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
}
