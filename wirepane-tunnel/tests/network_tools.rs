//! The network tools' commands through the real binary (docs/plans/2026-10-13-rust-network-tools.md):
//! every command's reply, bad input as an error event (never a crash), and the capture and DNS
//! hooks with traffic through a WireGuard client.

#[allow(dead_code)]
mod support;

use std::io::{BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use support::wg_client::WgClient;

struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<Value>,
    seen: Vec<Value>,
}

impl Sidecar {
    fn spawn(state: &Path, extra: &[&str]) -> Sidecar {
        // Nothing listens on this SOCKS port: these tests never need the proxy.
        let mut child = Command::new(env!("CARGO_BIN_EXE_wirepane-tunnel"))
            .args(["--wireguard", "127.0.0.1:0", "--socks", "127.0.0.1:9", "--endpoint-host", "127.0.0.1"])
            .arg("--state")
            .arg(state)
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
                let value: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}"));
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        Sidecar { child, stdin, events: rx, seen: Vec::new() }
    }

    fn wait_after(&mut self, mark: usize, matches: impl Fn(&Value) -> bool, what: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
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

    /// Sends a command and returns its answer: the expected event or an error event.
    fn ask(&mut self, command: Value, answer: &str) -> Value {
        let mark = self.seen.len();
        let stdin = self.stdin.as_mut().expect("stdin is closed");
        writeln!(stdin, "{command}").unwrap();
        stdin.flush().unwrap();
        let name = answer.to_string();
        self.wait_after(mark, move |v| v["event"] == name.as_str() || v["event"] == "error", answer)
    }

    fn is_alive(&mut self) -> bool {
        self.child.try_wait().unwrap().is_none()
    }

    /// Closes the helper's stdin like a parent that is leaving, waits for it to exit and returns
    /// everything it printed.
    fn close_and_wait(&mut self) -> Vec<Value> {
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.is_alive() {
            assert!(Instant::now() < deadline, "the sidecar did not exit after its stdin closed");
            thread::sleep(Duration::from_millis(20));
        }
        // The reader thread ends with the process; take what it still has
        while let Ok(value) = self.events.recv_timeout(Duration::from_millis(500)) {
            self.seen.push(value);
        }
        self.seen.clone()
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

fn expect_event(answer: &Value, event: &str) {
    assert_eq!(answer["event"], event, "{answer}");
}

#[test]
fn ready_lists_the_capabilities_and_new_options_parse() {
    let dir = tempfile::tempdir().unwrap();
    let cert = dir.path().join("ca.pem");
    let key = dir.path().join("ca.key");
    std::fs::write(&cert, "not a real cert").unwrap();
    std::fs::write(&key, "not a real key").unwrap();
    let ikev2 = UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string();
    let mut sidecar = Sidecar::spawn(
        &dir.path().join("state.json"),
        &[
            "--quic",
            "decrypt",
            "--ca-cert",
            cert.to_str().unwrap(),
            "--ca-key",
            key.to_str().unwrap(),
            "--ikev2",
            &ikev2,
        ],
    );
    let ready = sidecar.wait_for("ready");
    let capabilities = &ready["capabilities"];
    assert!(capabilities["quicDecrypt"].is_boolean(), "{ready}");
    assert!(capabilities["ikev2"].is_boolean(), "{ready}");
    assert!(sidecar.is_alive());
}

#[test]
fn every_tool_command_answers_and_bad_input_is_an_error_event() {
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(&dir.path().join("state.json"), &[]);
    sidecar.wait_for("ready");

    // set-conditions
    let set = sidecar.ask(
        json!({"cmd": "set-conditions", "peer": "p1", "conditions": {"latencyMs": 200, "jitterMs": 20, "downKbps": 750, "upKbps": 250, "lossPct": 1.5}}),
        "conditions-set",
    );
    expect_event(&set, "conditions-set");
    assert_eq!(set["peer"], "p1");
    expect_event(&sidecar.ask(json!({"cmd": "set-conditions", "peer": "p1", "conditions": null}), "conditions-set"), "conditions-set");
    for bad in [
        json!({"cmd": "set-conditions", "conditions": null}),
        json!({"cmd": "set-conditions", "peer": "p1", "conditions": {"latencyMs": -5}}),
        json!({"cmd": "set-conditions", "peer": "p1", "conditions": {"lossPct": 150}}),
        json!({"cmd": "set-conditions", "peer": "p1", "conditions": "fast"}),
        json!({"cmd": "set-conditions", "peer": "../p1", "conditions": null}),
    ] {
        expect_event(&sidecar.ask(bad, "conditions-set"), "error");
    }

    // set-dns-rules
    let rules = sidecar.ask(
        json!({"cmd": "set-dns-rules", "rules": [
            {"pattern": "*.example.com", "action": "block"},
            {"pattern": "api.test", "action": "answer", "ipv4": "192.168.0.10"},
        ]}),
        "dns-rules-set",
    );
    expect_event(&rules, "dns-rules-set");
    assert_eq!(rules["count"], 2);
    for bad in [
        json!({"cmd": "set-dns-rules"}),
        json!({"cmd": "set-dns-rules", "rules": [{"pattern": "a.test", "action": "answer", "ipv4": "not-an-ip"}]}),
        json!({"cmd": "set-dns-rules", "rules": [{"pattern": "a.test", "action": "rewrite"}]}),
        json!({"cmd": "set-dns-rules", "rules": [{"action": "block"}]}),
    ] {
        expect_event(&sidecar.ask(bad, "dns-rules-set"), "error");
    }
    let cleared = sidecar.ask(json!({"cmd": "set-dns-rules", "rules": []}), "dns-rules-set");
    assert_eq!(cleared["count"], 0);

    // set-quic
    for mode in ["relay", "decrypt", "block"] {
        let answer = sidecar.ask(json!({"cmd": "set-quic", "mode": mode}), "quic-mode");
        expect_event(&answer, "quic-mode");
        assert_eq!(answer["mode"], mode);
    }
    expect_event(&sidecar.ask(json!({"cmd": "set-quic", "mode": "fast"}), "quic-mode"), "error");

    // capture-start / capture-stop
    let path = dir.path().join("one.pcapng");
    let started = sidecar.ask(json!({"cmd": "capture-start", "path": path}), "capture-started");
    expect_event(&started, "capture-started");
    assert_eq!(started["path"], path.to_str().unwrap());
    expect_event(&sidecar.ask(json!({"cmd": "capture-start", "path": path}), "capture-started"), "error");
    let stopped = sidecar.ask(json!({"cmd": "capture-stop"}), "capture-stopped");
    expect_event(&stopped, "capture-stopped");
    assert_eq!(stopped["path"], path.to_str().unwrap());
    assert!(stopped["packets"].is_u64() && stopped["bytes"].is_u64(), "{stopped}");
    assert!(path.exists());
    expect_event(&sidecar.ask(json!({"cmd": "capture-stop"}), "capture-stopped"), "error");
    expect_event(&sidecar.ask(json!({"cmd": "capture-start"}), "capture-started"), "error");
    // A path below a plain file can never be created.
    let plain_file = dir.path().join("plain-file");
    std::fs::write(&plain_file, "x").unwrap();
    let unwritable = plain_file.join("x.pcapng");
    expect_event(&sidecar.ask(json!({"cmd": "capture-start", "path": unwritable}), "capture-started"), "error");

    // Still alive, and the old commands still work.
    assert!(sidecar.is_alive());
    expect_event(&sidecar.ask(json!({"cmd": "list-peers"}), "peers"), "peers");
}

#[test]
fn a_capture_counts_the_tunnels_packets_and_dns_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(&dir.path().join("state.json"), &[]);
    sidecar.wait_for("ready");
    let added = sidecar.ask(json!({"cmd": "add-peer", "name": "Capture test", "kind": "wireguard"}), "peer-added");
    expect_event(&added, "peer-added");
    let peer = added["peer"].as_str().unwrap().to_string();

    let path = dir.path().join("dns.pcapng");
    expect_event(&sidecar.ask(json!({"cmd": "capture-start", "path": path}), "capture-started"), "capture-started");
    // Conditions on the phone put its packets through the shaper too; the stub lets them through.
    expect_event(
        &sidecar.ask(json!({"cmd": "set-conditions", "peer": peer, "conditions": {"latencyMs": 0}}), "conditions-set"),
        "conditions-set",
    );

    let mut client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");
    let answers = client.dns_a("localhost");
    assert!(!answers.is_empty(), "the DNS answer came back through the hooks");
    let mark = sidecar.seen.len();
    sidecar.wait_after(mark.saturating_sub(mark), |v| v["event"] == "dns" && v["name"] == "localhost", "the dns event");

    let stopped = sidecar.ask(json!({"cmd": "capture-stop"}), "capture-stopped");
    expect_event(&stopped, "capture-stopped");
    assert!(stopped["packets"].as_u64().unwrap() >= 2, "the query in and the answer out: {stopped}");
    assert!(stopped["bytes"].as_u64().unwrap() >= 2 * 28, "{stopped}");
}

/// The Enhanced Packet Blocks of a pcapng file as (interface, microseconds since 1970), after
/// checking that the blocks fill the file exactly.
fn pcapng_packets(path: &Path) -> Vec<(u32, u64)> {
    let bytes = std::fs::read(path).unwrap();
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let mut at = 0;
    let mut packets = Vec::new();
    while at < bytes.len() {
        assert!(bytes.len() - at >= 12, "a block is cut off at byte {at}");
        let total = word(at + 4) as usize;
        assert!(total >= 12 && total.is_multiple_of(4) && at + total <= bytes.len(), "bad block length {total} at byte {at}");
        assert_eq!(word(at + total - 4) as usize, total, "the closing length of the block at byte {at}");
        if word(at) == 6 {
            packets.push((word(at + 8), (u64::from(word(at + 12)) << 32) | u64::from(word(at + 16))));
        }
        at += total;
    }
    packets
}

fn contains(bytes: &[u8], needle: &[u8]) -> bool {
    bytes.windows(needle.len()).any(|window| window == needle)
}

/// A sidecar with one phone that has said hello, ready for traffic.
fn sidecar_with_phone(dir: &Path, name: &str) -> (Sidecar, WgClient, Value) {
    let mut sidecar = Sidecar::spawn(&dir.join("state.json"), &[]);
    sidecar.wait_for("ready");
    let added = sidecar.ask(json!({"cmd": "add-peer", "name": name, "kind": "wireguard"}), "peer-added");
    expect_event(&added, "peer-added");
    let client = WgClient::connect(added["config"].as_str().unwrap()).expect("handshake");
    (sidecar, client, added)
}

#[test]
fn a_running_capture_is_finished_and_reported_when_the_helper_stops() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sidecar, mut client, added) = sidecar_with_phone(dir.path(), "Capture test");

    // Started after the handshake, so the exchange below happens within the capture's first flush
    // interval: if the helper did not finish the capture, its packets would still be in the write
    // buffer when it leaves.
    let path = dir.path().join("leaving.pcapng");
    expect_event(&sidecar.ask(json!({"cmd": "capture-start", "path": path}), "capture-started"), "capture-started");
    assert!(!client.dns_a("localhost").is_empty(), "the DNS answer came back");

    // The parent goes away without a capture-stop
    let events = sidecar.close_and_wait();
    let stopped = events
        .iter()
        .find(|event| event["event"] == "capture-stopped")
        .unwrap_or_else(|| panic!("the helper did not report the capture: {events:#?}"));
    assert_eq!(stopped["reason"], "helper stopped");
    assert_eq!(stopped["path"], path.to_str().unwrap());
    let packets = stopped["packets"].as_u64().unwrap();
    assert!(packets >= 2, "the query in and the answer out: {stopped}");

    assert_eq!(pcapng_packets(&path).len() as u64, packets, "the file holds every packet the event counts");
    let bytes = std::fs::read(&path).unwrap();
    assert!(contains(&bytes, b"Capture test"), "the phone's interface is named after its device");
    assert!(contains(&bytes, added["peer"].as_str().unwrap().as_bytes()), "and described by its id");
}

#[test]
fn a_delayed_packet_is_captured_when_it_leaves_and_not_when_it_is_queued() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sidecar, mut client, added) = sidecar_with_phone(dir.path(), "Slow phone");
    let peer = added["peer"].as_str().unwrap().to_string();
    expect_event(
        &sidecar.ask(json!({"cmd": "set-conditions", "peer": peer, "conditions": {"latencyMs": 300}}), "conditions-set"),
        "conditions-set",
    );

    let path = dir.path().join("slow.pcapng");
    expect_event(&sidecar.ask(json!({"cmd": "capture-start", "path": path}), "capture-started"), "capture-started");
    let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as u64;
    assert!(!client.dns_a("localhost").is_empty(), "the DNS answer came back through 300 ms of latency each way");
    expect_event(&sidecar.ask(json!({"cmd": "capture-stop"}), "capture-stopped"), "capture-stopped");

    let packets = pcapng_packets(&path);
    assert!(packets.len() >= 2, "the query in and the answer out: {packets:?}");
    // The query sat 300 ms in the shaper's queue, and is in the capture from the moment it left
    let (query, answer) = (packets[0].1, packets[1].1);
    assert!(query >= before + 250_000, "the query is stamped {} ms after it came in", (query - before) / 1000);
    // And the answer waited another 300 ms
    assert!(answer >= query + 250_000, "the answer is stamped {} ms after the query", (answer - query) / 1000);
}

#[test]
fn a_second_capture_with_the_same_path_goes_to_a_numbered_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut sidecar = Sidecar::spawn(&dir.path().join("state.json"), &[]);
    sidecar.wait_for("ready");
    let path = dir.path().join("wirepane-same-second.pcapng");

    let first = sidecar.ask(json!({"cmd": "capture-start", "path": path}), "capture-started");
    assert_eq!(first["path"], path.to_str().unwrap());
    let stopped = sidecar.ask(json!({"cmd": "capture-stop"}), "capture-stopped");
    assert_eq!(stopped["path"], path.to_str().unwrap());
    let first_file = std::fs::read(&path).unwrap();

    // The same name again: the reply says where the capture really is, and the first file is left alone
    let numbered = dir.path().join("wirepane-same-second-2.pcapng");
    let second = sidecar.ask(json!({"cmd": "capture-start", "path": path}), "capture-started");
    expect_event(&second, "capture-started");
    assert_eq!(second["path"], numbered.to_str().unwrap());
    let stopped = sidecar.ask(json!({"cmd": "capture-stop"}), "capture-stopped");
    assert_eq!(stopped["path"], numbered.to_str().unwrap());
    assert!(numbered.is_file());
    assert_eq!(std::fs::read(&path).unwrap(), first_file, "the first capture is untouched");
}
