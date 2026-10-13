//! End-to-end tests of the real `wirepane-tunnel` binary. A WireGuard client (boringtun + smoltcp,
//! in `support/`) talks to it over UDP; a test SOCKS5 server plays Mockttp and records the tags
//! and the CONNECT target of every flow.

mod support;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use serde_json::{Value, json};
use smoltcp::wire::{Icmpv4Message, Icmpv4Packet, IpProtocol, Ipv4Packet};
use support::wg_client::{WgClient, dns_frame, dns_frames, dns_query_bytes, parse_a_answers, parse_config};

const BODY: &str = "hello from the test server";
const BIG_BODY_LEN: usize = 1_500_000;

fn big_body() -> Vec<u8> {
    (0..BIG_BODY_LEN).map(|i| (i % 251) as u8).collect()
}

// ---------------------------------------------------------------- test servers

fn start_http() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let mut stream = stream;
                let mut seen = Vec::new();
                let mut chunk = [0u8; 1024];
                while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => seen.extend_from_slice(&chunk[..n]),
                    }
                }
                let head_end = seen.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                let head = String::from_utf8_lossy(&seen[..head_end]).to_string();
                let request_line = head.lines().next().unwrap_or("").to_string();

                // GET /stream/<n>: n bytes of a repeating pattern, for throughput runs.
                if let Some(rest) = request_line.strip_prefix("GET /stream/") {
                    let total: usize = rest.split(' ').next().and_then(|n| n.parse().ok()).unwrap_or(0);
                    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n");
                    let _ = stream.write_all(head.as_bytes());
                    let pattern: Vec<u8> = (0..65536usize).map(|i| (i % 251) as u8).collect();
                    let mut sent = 0;
                    while sent < total {
                        let part = &pattern[..pattern.len().min(total - sent)];
                        if stream.write_all(part).is_err() {
                            return;
                        }
                        sent += part.len();
                    }
                    let _ = stream.shutdown(std::net::Shutdown::Write);
                    return;
                }
                // POST /sink: reads Content-Length bytes and answers with how many arrived.
                if request_line.starts_with("POST /sink") {
                    let wanted: usize = head
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                        .unwrap_or(0);
                    let mut got = seen.len() - head_end;
                    let mut buffer = vec![0u8; 65536];
                    while got < wanted {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => got += n,
                        }
                    }
                    let body = format!("got {got}");
                    let answer = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(answer.as_bytes());
                    let _ = stream.shutdown(std::net::Shutdown::Write);
                    return;
                }

                let (body, kind) = if seen.starts_with(b"GET /big") {
                    (big_body(), "application/octet-stream")
                } else {
                    (BODY.as_bytes().to_vec(), "text/plain")
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.shutdown(std::net::Shutdown::Write);
            });
        }
    });
    addr
}

#[derive(Debug, Clone)]
struct SocksRecord {
    tags: Vec<String>,
    target: String,
}

struct TestSocks {
    addr: SocketAddr,
    records: Arc<Mutex<Vec<SocksRecord>>>,
}

fn read_n(stream: &mut TcpStream, n: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; n];
    stream.read_exact(&mut buf)?;
    Ok(buf)
}

fn socks_session(mut client: TcpStream, forward_to: SocketAddr, records: Arc<Mutex<Vec<SocksRecord>>>) -> std::io::Result<()> {
    // Greeting: only custom-metadata (0xDA) is offered.
    let greeting = read_n(&mut client, 3)?;
    assert_eq!(greeting, [0x05, 0x01, 0xDA], "the sidecar must offer only custom-metadata");
    client.write_all(&[0x05, 0xDA])?;
    let len = read_n(&mut client, 2)?;
    let json_bytes = read_n(&mut client, usize::from(u16::from_be_bytes([len[0], len[1]])))?;
    let metadata: Value = serde_json::from_slice(&json_bytes).expect("metadata is JSON");
    let tags: Vec<String> = metadata["tags"]
        .as_array()
        .expect("tags array")
        .iter()
        .map(|t| t.as_str().unwrap().to_string())
        .collect();
    client.write_all(&[0x05, 0x00])?;

    let head = read_n(&mut client, 4)?;
    let target = match head[3] {
        1 => {
            let rest = read_n(&mut client, 6)?;
            format!(
                "{}.{}.{}.{}:{}",
                rest[0], rest[1], rest[2], rest[3], u16::from_be_bytes([rest[4], rest[5]])
            )
        }
        3 => {
            let name_len = read_n(&mut client, 1)?[0] as usize;
            let rest = read_n(&mut client, name_len + 2)?;
            format!(
                "{}:{}",
                String::from_utf8_lossy(&rest[..name_len]),
                u16::from_be_bytes([rest[name_len], rest[name_len + 1]])
            )
        }
        other => panic!("unexpected address type {other}"),
    };
    records.lock().unwrap().push(SocksRecord { tags, target });
    client.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])?;

    // Pass the bytes on to the local HTTP server, whatever the target was.
    let mut upstream = TcpStream::connect(forward_to)?;
    let mut upstream_reader = upstream.try_clone()?;
    let mut client_writer = client.try_clone()?;
    let back = thread::spawn(move || {
        let _ = std::io::copy(&mut upstream_reader, &mut client_writer);
        let _ = client_writer.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut client, &mut upstream);
    let _ = upstream.shutdown(std::net::Shutdown::Write);
    let _ = back.join();
    Ok(())
}

fn start_socks(forward_to: SocketAddr) -> TestSocks {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let records = Arc::new(Mutex::new(Vec::new()));
    let shared = records.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let records = shared.clone();
            thread::spawn(move || {
                let _ = socks_session(stream, forward_to, records);
            });
        }
    });
    TestSocks { addr, records }
}

// ---------------------------------------------------------------- the sidecar process

struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<Value>,
    seen: Vec<Value>,
}

impl Sidecar {
    fn spawn(socks: SocketAddr, state: &Path, wireguard: &str, extra: &[&str]) -> Sidecar {
        let mut child = Command::new(env!("CARGO_BIN_EXE_wirepane-tunnel"))
            .args(["--wireguard", wireguard])
            .arg("--state")
            .arg(state)
            .args(["--socks", &socks.to_string()])
            .args(["--endpoint-host", "127.0.0.1"])
            .args(extra)
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
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) => {
                        if tx.send(value).is_err() {
                            break;
                        }
                    }
                    Err(error) => panic!("stdout line is not JSON ({error}): {line}"),
                }
            }
        });
        Sidecar { child, stdin, events: rx, seen: Vec::new() }
    }

    fn send(&mut self, command: Value) {
        let stdin = self.stdin.as_mut().expect("stdin is closed");
        writeln!(stdin, "{command}").unwrap();
        stdin.flush().unwrap();
    }

    /// Waits for an event (after `mark` events were seen) that matches.
    fn wait_after(&mut self, mark: usize, matches: impl Fn(&Value) -> bool, what: &str) -> Value {
        self.wait_after_for(mark, matches, what, Duration::from_secs(10))
    }

    fn wait_after_for(&mut self, mark: usize, matches: impl Fn(&Value) -> bool, what: &str, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        let mut index = mark;
        loop {
            while index < self.seen.len() {
                if matches(&self.seen[index]) {
                    return self.seen[index].clone();
                }
                index += 1;
            }
            match self.events.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => self.seen.push(value),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => panic!("sidecar output ended while waiting for {what}"),
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}; saw {:#?}", self.seen);
        }
    }

    fn wait_for(&mut self, event: &str) -> Value {
        let name = event.to_string();
        self.wait_after(0, move |v| v["event"] == name.as_str(), event)
    }

    /// Sends a command and waits for the answer event.
    fn ask(&mut self, command: Value, answer: &str) -> Value {
        let mark = self.seen.len();
        self.send(command);
        let name = answer.to_string();
        self.wait_after(mark, move |v| v["event"] == name.as_str() || v["event"] == "error", answer)
    }

    fn close_stdin_and_wait(&mut self) -> std::process::ExitStatus {
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "the sidecar did not exit after stdin EOF");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn is_alive(&mut self) -> bool {
        self.child.try_wait().unwrap().is_none()
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

fn free_udp_port() -> u16 {
    UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn add_peer(sidecar: &mut Sidecar, name: &str) -> Value {
    let added = sidecar.ask(json!({ "cmd": "add-peer", "name": name, "kind": "wireguard" }), "peer-added");
    assert_eq!(added["event"], "peer-added", "{added}");
    added
}

// ---------------------------------------------------------------- tests

#[test]
fn dns_http_tags_quic_and_peer_management() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.json");
    let mut sidecar = Sidecar::spawn(socks.addr, &state, "127.0.0.1:0", &["--unsafe-allow-loopback"]);

    let ready = sidecar.wait_for("ready");
    assert!(ready["listen"].as_str().unwrap().starts_with("127.0.0.1:"));
    assert_eq!(ready["publicKey"].as_str().unwrap().len(), 44);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&state).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the state file holds private keys");
    }

    let added = add_peer(&mut sidecar, "Test phone");
    assert_eq!(added["peer"], "p1");
    assert_eq!(added["name"], "Test phone");
    assert_eq!(added["kind"], "wireguard");
    assert_eq!(added["tunnelIp"], "10.73.0.2");
    let config = added["config"].as_str().unwrap();
    for line in ["DNS = 10.73.0.53", "Address = 10.73.0.2/32", "AllowedIPs = 0.0.0.0/0, ::/0", "PersistentKeepalive = 25"] {
        assert!(config.contains(line), "config lacks {line:?}:\n{config}");
    }

    let mut client = WgClient::connect(config).expect("handshake");
    let peer_event = sidecar.wait_for("peer");
    assert_eq!(peer_event["peer"], "p1");
    assert!(peer_event["endpoint"].as_str().unwrap().starts_with("127.0.0.1:"));
    assert!(peer_event["lastHandshake"].as_u64().unwrap() > 1_700_000_000_000);

    // DNS resolves on the host and logs an event; AAAA is empty.
    assert_eq!(client.dns_a("localhost"), vec![Ipv4Addr::LOCALHOST]);
    let dns_event = sidecar.wait_after(0, |v| v["event"] == "dns" && v["name"] == "localhost" && v["qtype"] == "A", "dns A event");
    assert_eq!(dns_event["rcode"], "NOERROR");
    assert_eq!(dns_event["answers"], json!(["127.0.0.1"]));
    assert!(dns_event["ms"].is_u64());
    let aaaa = client.dns_query_raw("localhost", 28).expect("AAAA answer");
    assert_eq!(aaaa[3] & 0x0F, 0, "AAAA is NOERROR");
    assert_eq!(u16::from_be_bytes([aaaa[6], aaaa[7]]), 0, "AAAA has no records");
    let missing = client.dns_query_raw("does-not-exist.invalid", 1).expect("NXDOMAIN answer");
    assert_eq!(missing[3] & 0x0F, 3, "unknown names are NXDOMAIN");

    // An HTTP GET through the tunnel reaches the SOCKS server with tags and the original IP:port.
    let response = client.http_get(Ipv4Addr::LOCALHOST, http.port(), "localhost", "/hello").expect("GET");
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    assert!(response.ends_with(BODY), "{response}");
    {
        let records = socks.records.lock().unwrap();
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(records[0].target, format!("127.0.0.1:{}", http.port()));
        for tag in [
            "wirepane-vpn",
            "wirepane-vpn-peer:p1",
            "wirepane-vpn-endpoint:127.0.0.1",
            "wirepane-vpn-name:localhost",
        ] {
            assert!(records[0].tags.contains(&tag.to_string()), "missing {tag}: {:?}", records[0].tags);
        }
    }

    // wirepane.cert resolves to a virtual address and goes to SOCKS by host name.
    assert_eq!(client.dns_a("wirepane.cert"), vec![Ipv4Addr::new(10, 73, 0, 54)]);
    let cert = client.http_get(Ipv4Addr::new(10, 73, 0, 54), 80, "wirepane.cert", "/certificate").expect("cert GET");
    assert!(cert.ends_with(BODY), "{cert}");
    {
        let records = socks.records.lock().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].target, "wirepane.cert:80");
        assert!(records[1].tags.contains(&"wirepane-vpn-name:wirepane.cert".to_string()));
    }

    // QUIC (UDP/443) is blocked and reported.
    assert!(client.udp_exchange(Ipv4Addr::new(93, 184, 216, 34), 443, b"not really quic", Duration::from_millis(600)).is_none());
    let quic = sidecar.wait_after(0, |v| v["event"] == "quic", "quic event");
    assert_eq!(quic["action"], "blocked");
    assert_eq!(quic["dst"], "93.184.216.34:443");
    assert_eq!(quic["peer"], "p1");

    // Other UDP is relayed (an echo server on loopback stands in for the internet).
    let echo = UdpSocket::bind("127.0.0.1:0").unwrap();
    echo.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    let echo_thread = thread::spawn(move || {
        let mut buf = [0u8; 512];
        let (n, from) = echo.recv_from(&mut buf).unwrap();
        echo.send_to(&buf[..n], from).unwrap();
    });
    let echoed = client.udp_exchange(Ipv4Addr::LOCALHOST, echo_port, b"ping over udp", Duration::from_secs(5));
    assert_eq!(echoed.as_deref(), Some(&b"ping over udp"[..]));
    echo_thread.join().unwrap();
    let opened = sidecar.wait_after(0, |v| v["event"] == "udp-open", "udp-open event");
    assert_eq!(opened["dst"], format!("127.0.0.1:{echo_port}"));

    // list-peers shows the live endpoint and handshake time.
    let listed = sidecar.ask(json!({ "cmd": "list-peers" }), "peers");
    let first = &listed["peers"][0];
    assert_eq!(first["peer"], "p1");
    assert_eq!(first["tunnelIp"], "10.73.0.2");
    assert!(first["endpoint"].as_str().unwrap().starts_with("127.0.0.1:"));
    assert!(first["lastHandshake"].is_u64());

    // set-socks is accepted and checked.
    let socks_set = sidecar.ask(json!({ "cmd": "set-socks", "addr": socks.addr.to_string() }), "socks-set");
    assert_eq!(socks_set["addr"], socks.addr.to_string());
    let bad_socks = sidecar.ask(json!({ "cmd": "set-socks", "addr": "nonsense" }), "socks-set");
    assert_eq!(bad_socks["event"], "error");

    // remove-peer: the phone is cut off at once.
    let removed = sidecar.ask(json!({ "cmd": "remove-peer", "peer": "p1" }), "peer-removed");
    assert_eq!(removed["peer"], "p1");
    assert!(client.udp_exchange(client.config.dns, 53, &[0u8; 12], Duration::from_millis(800)).is_none());
    let listed = sidecar.ask(json!({ "cmd": "list-peers" }), "peers");
    assert_eq!(listed["peers"], json!([]));
    let again = sidecar.ask(json!({ "cmd": "remove-peer", "peer": "p1" }), "peer-removed");
    assert_eq!(again["event"], "error");

    // stdin EOF ends the process cleanly.
    let status = sidecar.close_stdin_and_wait();
    assert!(status.success(), "{status:?}");
}

#[test]
fn peers_and_keys_survive_a_restart() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("nested").join("state.json");
    let wireguard = format!("127.0.0.1:{}", free_udp_port());

    let mut first = Sidecar::spawn(socks.addr, &state, &wireguard, &[]);
    let public_key = first.wait_for("ready")["publicKey"].clone();
    let added = add_peer(&mut first, "Keeps working");
    let config = added["config"].as_str().unwrap().to_string();
    assert!(first.close_stdin_and_wait().success());
    drop(first);

    let mut second = Sidecar::spawn(socks.addr, &state, &wireguard, &[]);
    assert_eq!(second.wait_for("ready")["publicKey"], public_key, "the server key must not change");
    let listed = second.ask(json!({ "cmd": "list-peers" }), "peers");
    assert_eq!(listed["peers"][0]["peer"], "p1");
    assert_eq!(listed["peers"][0]["name"], "Keeps working");
    assert_eq!(listed["peers"][0]["endpoint"], Value::Null);

    // The config that was "scanned" before the restart still works.
    let mut client = WgClient::connect(&config).expect("old config still handshakes");
    assert_eq!(client.dns_a("wirepane.cert"), vec![Ipv4Addr::new(10, 73, 0, 54)]);

    // Ids and addresses are never reused.
    let next = add_peer(&mut second, "Second phone");
    assert_eq!(next["peer"], "p2");
    assert_eq!(next["tunnelIp"], "10.73.0.3");
    second.ask(json!({ "cmd": "remove-peer", "peer": "p2" }), "peer-removed");
    let third = add_peer(&mut second, "Third phone");
    assert_eq!(third["peer"], "p3");
}

#[test]
fn loopback_is_off_limits_by_default() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &[]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "Nosy phone");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");

    // A phone must not reach the Mac's own services (the server API, Mockttp admin) via 127.0.0.1.
    let started = Instant::now();
    let result = client.http_get(Ipv4Addr::LOCALHOST, http.port(), "localhost", "/");
    // The phone gets a clean, fast close (not a hang until its own timeout).
    assert_eq!(result.as_deref(), Ok(""), "blocked flows close cleanly");
    assert!(started.elapsed() < Duration::from_secs(5));
    thread::sleep(Duration::from_millis(300));
    assert!(socks.records.lock().unwrap().is_empty(), "no SOCKS connection may be opened");
}

#[test]
fn garbage_and_unknown_peers_do_not_crash_it() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &[]);
    let ready = sidecar.wait_for("ready");
    let listen: SocketAddr = ready["listen"].as_str().unwrap().parse().unwrap();
    let added = add_peer(&mut sidecar, "Real phone");

    // Random junk, truncated WireGuard messages, a handshake from a key nobody added, and data
    // packets for sessions that don't exist.
    let attacker = UdpSocket::bind("127.0.0.1:0").unwrap();
    let mut state = 0x1234_5678_u32;
    let mut next = || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (state >> 24) as u8
    };
    for round in 0..300usize {
        let len = round % 200;
        let mut junk: Vec<u8> = (0..len).map(|_| next()).collect();
        if round % 3 == 0 && !junk.is_empty() {
            junk[0] = 1 + (round % 4) as u8; // WireGuard message types 1 to 4
        }
        let _ = attacker.send_to(&junk, listen);
    }
    let mut fake_init = vec![1u8, 0, 0, 0];
    fake_init.extend((0..144).map(|_| next()));
    let _ = attacker.send_to(&fake_init, listen);
    let mut fake_data = vec![4u8, 0, 0, 0, 0x99, 0x01, 0, 0];
    fake_data.extend((0..64).map(|_| next()));
    let _ = attacker.send_to(&fake_data, listen);
    thread::sleep(Duration::from_millis(200));

    assert!(sidecar.is_alive(), "garbage must not stop the sidecar");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("a real phone still works");
    assert_eq!(client.dns_a("wirepane.cert"), vec![Ipv4Addr::new(10, 73, 0, 54)]);
    assert!(parse_a_answers(&[1, 2, 3]).is_empty());
}

#[test]
fn bad_arguments_exit_with_an_error_event() {
    let output = Command::new(env!("CARGO_BIN_EXE_wirepane-tunnel"))
        .args(["--wireguard", "127.0.0.1:0"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let line = String::from_utf8_lossy(&output.stdout);
    let event: Value = serde_json::from_str(line.lines().next().unwrap()).unwrap();
    assert_eq!(event["event"], "error");
    assert!(event["message"].as_str().unwrap().contains("--state"));
}

#[test]
fn a_big_download_arrives_complete() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &["--unsafe-allow-loopback"]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "Downloader");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");

    // 1.5 MB is far more than the stack's 64 KiB buffers, so this exercises back-pressure and the
    // half-close at the end (the server closes right after the last byte).
    let started = Instant::now();
    let raw = client
        .http_get_bytes(Ipv4Addr::LOCALHOST, http.port(), "localhost", "/big")
        .expect("big GET");
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("response head") + 4;
    assert!(raw.starts_with(b"HTTP/1.1 200 OK"));
    assert_eq!(&raw[split..], &big_body()[..], "the body must arrive complete and in order");
    eprintln!("downloaded {BIG_BODY_LEN} bytes through the tunnel in {:?} (debug build, test client)", started.elapsed());
}

#[test]
fn a_phone_that_closes_its_side_first_still_gets_the_answer() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &["--unsafe-allow-loopback"]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "Half closer");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");

    // FIN right after the request: the sidecar has to pass it on as a half-close, not tear down
    // the whole connection, so the answer can still come back.
    let raw = client
        .http_get_half_closed(Ipv4Addr::LOCALHOST, http.port(), "localhost", "/hello")
        .expect("half-closed GET");
    let text = String::from_utf8_lossy(&raw);
    assert!(text.starts_with("HTTP/1.1 200 OK"), "{text}");
    assert!(text.ends_with(BODY), "{text}");
}

// ---------------------------------------------------------------- DNS over TCP

#[test]
fn dns_over_tcp_answers_framed_queries() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &[]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "TCP resolver");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");
    let dns = client.config.dns;

    // One query in one segment.
    let query = dns_query_bytes("localhost", 1, 0x1111);
    let reply = client
        .tcp_exchange(dns, 53, &[dns_frame(&query)], |bytes| dns_frames(bytes).len() == 1, Duration::from_secs(5))
        .expect("DNS over TCP");
    let messages = dns_frames(&reply);
    assert_eq!(messages.len(), 1, "{reply:02x?}");
    assert_eq!(u16::from_be_bytes([messages[0][0], messages[0][1]]), 0x1111, "the answer keeps the query id");
    assert_eq!(parse_a_answers(&messages[0]), vec![Ipv4Addr::LOCALHOST]);

    // Two queries on one connection, the first split in the middle of its length prefix: the
    // sidecar has to buffer until a whole message is there, then answer both in order.
    let first = dns_frame(&dns_query_bytes("wirepane.cert", 1, 0x2222));
    let second = dns_frame(&dns_query_bytes("localhost", 28, 0x3333));
    let mut rest = first[1..].to_vec();
    rest.extend_from_slice(&second);
    let reply = client
        .tcp_exchange(dns, 53, &[first[..1].to_vec(), rest], |bytes| dns_frames(bytes).len() == 2, Duration::from_secs(5))
        .expect("pipelined DNS over TCP");
    let messages = dns_frames(&reply);
    assert_eq!(messages.len(), 2, "{reply:02x?}");
    assert_eq!(u16::from_be_bytes([messages[0][0], messages[0][1]]), 0x2222);
    assert_eq!(parse_a_answers(&messages[0]), vec![Ipv4Addr::new(10, 73, 0, 54)], "wirepane.cert");
    assert_eq!(u16::from_be_bytes([messages[1][0], messages[1][1]]), 0x3333);
    assert_eq!(messages[1][3] & 0x0F, 0, "AAAA is NOERROR");
    assert_eq!(u16::from_be_bytes([messages[1][6], messages[1][7]]), 0, "AAAA has no records");

    // The queries are logged like UDP ones, and none of this went to Mockttp.
    sidecar.wait_after(0, |v| v["event"] == "dns" && v["name"] == "wirepane.cert" && v["qtype"] == "A", "dns event for the TCP query");
    assert!(socks.records.lock().unwrap().is_empty(), "DNS over TCP is answered by the sidecar itself");
}

// ---------------------------------------------------------------- QUIC, UDP events and stats

#[test]
fn quic_gets_icmp_udp_updates_and_stats() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &["--unsafe-allow-loopback"]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "Stats phone");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");
    assert_eq!(client.dns_a("localhost"), vec![Ipv4Addr::LOCALHOST]);

    // A QUIC datagram is answered with ICMP port unreachable that quotes it.
    let quic_server = Ipv4Addr::new(93, 184, 216, 34);
    assert!(client.udp_exchange(quic_server, 443, b"pretend quic initial", Duration::from_millis(500)).is_none());
    client.pump_for(Duration::from_millis(200));
    assert_eq!(client.icmp_received.len(), 1, "one ICMP error for one datagram");
    let bytes = client.icmp_received[0].clone();
    let ip = Ipv4Packet::new_checked(&bytes[..]).expect("IPv4");
    assert!(ip.verify_checksum());
    assert_eq!(ip.next_header(), IpProtocol::Icmp);
    assert_eq!(ip.src_addr(), quic_server, "the error comes from the server the phone tried");
    assert_eq!(ip.dst_addr(), client.config.address);
    let icmp = Icmpv4Packet::new_checked(ip.payload()).expect("ICMP");
    assert!(icmp.verify_checksum());
    assert_eq!(icmp.msg_type(), Icmpv4Message::DstUnreachable);
    assert_eq!(icmp.msg_code(), 3, "port unreachable");
    let quote = icmp.data();
    assert_eq!(quote.len(), 28, "the original IPv4 header and 8 bytes");
    let original = Ipv4Packet::new_unchecked(quote);
    assert_eq!(original.src_addr(), client.config.address);
    assert_eq!(original.dst_addr(), quic_server);
    assert_eq!(original.next_header(), IpProtocol::Udp);
    assert_eq!(u16::from_be_bytes([quote[22], quote[23]]), 443, "the quoted destination port");
    assert!(u16::from_be_bytes([quote[20], quote[21]]) > 40000, "the quoted source port is the phone's socket");
    let quic = sidecar.wait_after(0, |v| v["event"] == "quic", "quic event");
    assert_eq!(quic["action"], "blocked");
    assert_eq!(quic["dst"], "93.184.216.34:443");

    // Relayed UDP: one echo, then a throttled udp-update with the counts.
    let echo = UdpSocket::bind("127.0.0.1:0").unwrap();
    echo.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    let echo_thread = thread::spawn(move || {
        let mut buf = [0u8; 512];
        let (n, from) = echo.recv_from(&mut buf).unwrap();
        echo.send_to(&buf[..n], from).unwrap();
    });
    let payload = b"counted datagram";
    let echoed = client.udp_exchange(Ipv4Addr::LOCALHOST, echo_port, payload, Duration::from_secs(5));
    assert_eq!(echoed.as_deref(), Some(&payload[..]));
    echo_thread.join().unwrap();

    let opened = sidecar.wait_after(0, |v| v["event"] == "udp-open", "udp-open");
    let update = sidecar.wait_after(0, |v| v["event"] == "udp-update", "udp-update");
    assert_eq!(update["flow"], opened["flow"]);
    assert_eq!(update["peer"], "p1");
    assert_eq!(update["packetsUp"], 1);
    assert_eq!(update["packetsDown"], 1);
    assert_eq!(update["bytesUp"], payload.len());
    assert_eq!(update["bytesDown"], payload.len());

    let stats = sidecar.ask(json!({ "cmd": "stats" }), "stats");
    assert_eq!(stats["event"], "stats", "{stats}");
    assert!(stats["uptimeMs"].is_u64());
    assert_eq!(stats["udp"]["flowsOpened"], 1);
    assert_eq!(stats["udp"]["flowsActive"], 1, "the relay lives until its idle timeout");
    assert_eq!(stats["udp"]["packetsUp"], 1);
    assert_eq!(stats["udp"]["bytesDown"], payload.len());
    assert!(stats["dns"]["queries"].as_u64().unwrap() >= 1);
    assert_eq!(stats["quic"]["blocked"], 1);
    assert_eq!(stats["quic"]["icmpSent"], 1);
    assert_eq!(stats["tcp"]["flowsActive"], 0);
    let peer = &stats["peers"][0];
    assert_eq!(peer["peer"], "p1");
    assert_eq!(peer["tunnelIp"], "10.73.0.2");
    assert!(peer["bytesUp"].as_u64().unwrap() > 0 && peer["bytesDown"].as_u64().unwrap() > 0, "{peer}");
    assert!(peer["endpoint"].as_str().unwrap().starts_with("127.0.0.1:"));

    // An idle flow reports nothing more: the update is sent once per change, not once per second.
    thread::sleep(Duration::from_millis(2300));
    sidecar.ask(json!({ "cmd": "stats" }), "stats");
    let updates = sidecar.seen.iter().filter(|v| v["event"] == "udp-update").count();
    assert_eq!(updates, 1, "no repeat for an unchanged flow");
}

// ---------------------------------------------------------------- WireGuard timers and the rate limiter

/// A bare WireGuard initiator for one phone config: just enough to send handshake initiations and
/// look at what comes back (message type 2 = handshake response, 3 = cookie reply).
struct RawInitiator {
    socket: UdpSocket,
    tunn: Tunn,
    buf: Vec<u8>,
}

impl RawInitiator {
    fn new(config_text: &str) -> RawInitiator {
        let config = parse_config(config_text);
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket.connect(config.endpoint).unwrap();
        socket.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        let tunn = Tunn::new(StaticSecret::from(config.private_key), PublicKey::from(config.server_public), None, None, 9, None);
        RawInitiator { socket, tunn, buf: vec![0u8; 2048] }
    }

    /// Sends a new handshake initiation (with the cookie, once one has been received).
    fn initiate(&mut self) {
        if let TunnResult::WriteToNetwork(init) = self.tunn.format_handshake_initiation(&mut self.buf, true) {
            self.socket.send(init).unwrap();
        }
    }

    /// The next datagram from the server, if one arrives within half a second.
    fn receive(&mut self) -> Option<Vec<u8>> {
        let mut datagram = vec![0u8; 2048];
        let len = self.socket.recv(&mut datagram).ok()?;
        datagram.truncate(len);
        Some(datagram)
    }

    /// Lets the Noise state see a reply (a cookie reply stores the cookie for the next initiation).
    fn feed(&mut self, datagram: &[u8]) {
        let _ = self.tunn.decapsulate(None, datagram, &mut self.buf);
    }
}

fn message_type(datagram: &[u8]) -> u8 {
    datagram[0]
}

#[test]
fn a_handshake_flood_gets_cookie_replies_and_the_limiter_resets() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &[]);
    let ready = sidecar.wait_for("ready");
    let listen: SocketAddr = ready["listen"].as_str().unwrap().parse().unwrap();
    let added = add_peer(&mut sidecar, "Flooded phone");
    let config_text = added["config"].as_str().unwrap().to_string();
    let config = parse_config(&config_text);

    // Quiet: an initiation gets a handshake response straight away.
    let mut phone = RawInitiator::new(&config_text);
    phone.initiate();
    let reply = phone.receive().expect("a reply to a quiet initiation");
    assert_eq!(message_type(&reply), 2, "handshake response, got {reply:02x?}");

    // Someone floods the port with initiations (valid MAC1, a key nobody added), more than the limit.
    let attacker = UdpSocket::bind("127.0.0.1:0").unwrap();
    attacker.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
    let mut random_key = [0u8; 32];
    getrandom::getrandom(&mut random_key).unwrap();
    let mut flooder = Tunn::new(StaticSecret::from(random_key), PublicKey::from(config.server_public), None, None, 77, None);
    let mut buf = vec![0u8; 2048];

    // The phone must be turned away with a cookie while the flood lasts, and get in with it. A
    // second boundary can fall in the middle of an attempt and reset the count, so try a few times.
    let mut cookie_replies_seen = 0;
    let mut let_in_with_cookie = false;
    for _attempt in 0..4 {
        for _ in 0..1000 {
            if let TunnResult::WriteToNetwork(init) = flooder.format_handshake_initiation(&mut buf, true) {
                let _ = attacker.send_to(init, listen);
            }
        }
        phone.initiate();
        let Some(reply) = phone.receive() else { continue };
        if message_type(&reply) != 3 {
            continue; // the count was reset in between: flood again
        }
        assert_eq!(reply.len(), 64, "a cookie reply is 64 bytes");
        cookie_replies_seen += 1;
        phone.feed(&reply);
        phone.initiate(); // now carries MAC2 made from the cookie
        let answer = phone.receive().expect("an answer to the initiation with a cookie");
        assert_eq!(message_type(&answer), 2, "with its cookie the phone gets through even under load");
        let_in_with_cookie = true;
        break;
    }
    assert!(cookie_replies_seen > 0 && let_in_with_cookie, "the flood never produced a cookie reply");

    // The attacker itself was answered with cookies, not with handshake responses or silence.
    let mut attacker_cookies = 0;
    let mut reply = vec![0u8; 2048];
    while let Ok(len) = attacker.recv(&mut reply) {
        if len == 64 && reply[0] == 3 {
            attacker_cookies += 1;
        }
    }
    assert!(attacker_cookies > 0, "the flooder got no cookie replies");

    // After the flood the 250 ms timer resets the count, so a fresh initiation is served directly.
    thread::sleep(Duration::from_millis(1600));
    let mut later = RawInitiator::new(&config_text);
    later.initiate();
    let reply = later.receive().expect("a reply after the flood");
    assert_eq!(message_type(&reply), 2, "the limiter must reset on the timer tick, got {reply:02x?}");

    // And a flood never stops a phone that is already connected.
    assert!(sidecar.is_alive());
    let mut client = WgClient::connect(&config_text).expect("a normal handshake after the flood");
    assert_eq!(client.dns_a("wirepane.cert"), vec![Ipv4Addr::new(10, 73, 0, 54)]);
}

#[test]
fn the_server_sends_a_keepalive_when_it_has_heard_from_a_phone_and_said_nothing() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &["--unsafe-allow-loopback"]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "Quiet phone");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");

    // One datagram to a socket that never answers: the server has data from the phone and nothing
    // to send back. WireGuard's rule is an empty packet after 10 s, and only the timer can send it.
    // The pause keeps the datagram in a later 250 ms tick than the handshake reply, which is what
    // boringtun needs to see "heard after we last spoke".
    let silent = UdpSocket::bind("127.0.0.1:0").unwrap();
    client.pump_for(Duration::from_millis(700));
    assert!(client.udp_exchange(Ipv4Addr::LOCALHOST, silent.local_addr().unwrap().port(), b"anyone there?", Duration::from_millis(300)).is_none());
    assert_eq!(client.keepalives_received, 0, "no keepalive yet");

    let deadline = Instant::now() + Duration::from_secs(14);
    while client.keepalives_received == 0 && Instant::now() < deadline {
        client.pump_for(Duration::from_millis(100));
    }
    assert!(client.keepalives_received >= 1, "the server never sent a keepalive: its timers do not run");
    // The tunnel still works afterwards.
    assert_eq!(client.dns_a("wirepane.cert"), vec![Ipv4Addr::new(10, 73, 0, 54)]);
}

// ---------------------------------------------------------------- throughput

/// Megabytes moved through the tunnel by the whole pipeline in this process: the test client
/// (boringtun + smoltcp), the sidecar binary and a local HTTP server behind the stub SOCKS proxy.
/// For a number worth quoting run it optimised and alone:
///   cargo test --release --test tunnel throughput -- --nocapture --test-threads=1
/// WIREPANE_BENCH_MB sets the size of each transfer (default 16).
#[test]
fn throughput_through_the_tunnel() {
    let megabytes: usize = std::env::var("WIREPANE_BENCH_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(16);
    let total = megabytes * 1024 * 1024;
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &["--unsafe-allow-loopback"]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "Bench phone");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");

    // Download: the server streams `total` bytes, the phone reads them.
    let started = Instant::now();
    let raw = client
        .http_get_bytes(Ipv4Addr::LOCALHOST, http.port(), "localhost", &format!("/stream/{total}"))
        .expect("download");
    let download = started.elapsed();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("response head") + 4;
    assert_eq!(raw.len() - split, total, "the whole download arrives");
    let download_rate = megabytes as f64 / download.as_secs_f64();

    // Upload: the phone posts `total` bytes, the server counts them.
    let started = Instant::now();
    let answer = client
        .http_post_pattern(Ipv4Addr::LOCALHOST, http.port(), "localhost", "/sink", total)
        .expect("upload");
    let upload = started.elapsed();
    let text = String::from_utf8_lossy(&answer);
    assert!(text.ends_with(&format!("got {total}")), "the server must receive every byte: {text}");
    let upload_rate = megabytes as f64 / upload.as_secs_f64();

    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    eprintln!(
        "throughput ({profile} build, {megabytes} MB each way, loopback): download {download_rate:.1} MB/s ({download:?}), upload {upload_rate:.1} MB/s ({upload:?})"
    );
    // A floor far below anything real, only to catch a stall or a back-pressure bug.
    assert!(download_rate > 1.0 && upload_rate > 1.0, "the tunnel crawls: {download_rate:.2} / {upload_rate:.2} MB/s");
}

#[test]
fn a_session_that_goes_quiet_is_refreshed_by_the_server() {
    let http = start_http();
    let socks = start_socks(http);
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(socks.addr, &dir.path().join("state.json"), "127.0.0.1:0", &["--unsafe-allow-loopback"]);
    sidecar.wait_for("ready");
    let added = add_peer(&mut sidecar, "Sleepy phone");
    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");
    let first = sidecar.wait_for("peer");
    let first_handshake = first["lastHandshake"].as_u64().unwrap();

    // The phone sends a datagram and the answer comes back a moment later (in a later 250 ms tick).
    // Then the phone falls silent: the test client stops running, so it sends no acknowledging
    // keepalive either. The server has sent data and heard nothing for 15 s, and WireGuard's rule
    // is to start a new handshake with the phone.
    client.pump_for(Duration::from_millis(500));
    let slow_echo = UdpSocket::bind("127.0.0.1:0").unwrap();
    slow_echo.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let echo_port = slow_echo.local_addr().unwrap().port();
    let echo_thread = thread::spawn(move || {
        let mut buf = [0u8; 512];
        let (n, from) = slow_echo.recv_from(&mut buf).unwrap();
        thread::sleep(Duration::from_millis(700));
        slow_echo.send_to(&buf[..n], from).unwrap();
    });
    let echoed = client.udp_exchange(Ipv4Addr::LOCALHOST, echo_port, b"slow echo", Duration::from_secs(5));
    assert_eq!(echoed.as_deref(), Some(&b"slow echo"[..]));
    echo_thread.join().unwrap();
    thread::sleep(Duration::from_secs(16));

    // The phone wakes up: the initiation the server sent while it slept is waiting in its socket.
    // It answers like a real phone would, and the sidecar must report the new handshake as it
    // reports one the phone started.
    let mark = sidecar.seen.len();
    client.pump_for(Duration::from_secs(3));
    let refreshed = sidecar.wait_after_for(
        mark,
        |v| v["event"] == "peer" && v["lastHandshake"].as_u64().unwrap_or(0) > first_handshake,
        "a peer event for the handshake the server started",
        Duration::from_secs(5),
    );
    assert_eq!(refreshed["peer"], "p1");
    // The tunnel still carries traffic over the new session.
    assert_eq!(client.dns_a("wirepane.cert"), vec![Ipv4Addr::new(10, 73, 0, 54)]);
}
