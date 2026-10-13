use std::net::SocketAddr;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use wirepane_tunnel::core::QuicMode;
use wirepane_tunnel::events::EventSink;
use wirepane_tunnel::net::TunnelNet;
use wirepane_tunnel::{PEER_KIND_WIREGUARD, Tunnel, TunnelConfig};

const USAGE: &str = "usage: wirepane-tunnel --wireguard <ip:port> --state <file> --socks <host:port>
                       [--endpoint-host <LAN IPv4 the phone dials>] [--tunnel-net 10.73.0.0/24]
                       [--quic block|relay|decrypt] [--ca-cert <pem> --ca-key <pem>] [--ikev2 <ip:port>]
commands (JSON lines on stdin): add-peer, remove-peer, list-peers, set-socks, stats, set-conditions,
set-dns-rules, set-quic, capture-start, capture-stop. EOF on stdin exits.";

/// Logs go to stderr (stdout is for events). Level comes from WIREPANE_TUNNEL_LOG (default warn).
struct StderrLogger(log::LevelFilter);

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.0
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}: {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

fn init_logger() {
    let level = match std::env::var("WIREPANE_TUNNEL_LOG").as_deref() {
        Ok("trace") => log::LevelFilter::Trace,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("info") => log::LevelFilter::Info,
        Ok("error") => log::LevelFilter::Error,
        _ => log::LevelFilter::Warn,
    };
    // Boxed and leaked on purpose: the logger lives as long as the process.
    let logger: &'static StderrLogger = Box::leak(Box::new(StderrLogger(level)));
    log::set_logger(logger).ok();
    log::set_max_level(level);
}

fn parse_args(args: Vec<String>) -> Result<TunnelConfig> {
    let mut wireguard: Option<SocketAddr> = None;
    let mut state: Option<PathBuf> = None;
    let mut socks: Option<String> = None;
    let mut endpoint_host: Option<String> = None;
    let mut tunnel_net = TunnelNet::parse("10.73.0.0/24")?;
    let mut quic = QuicMode::Block;
    let mut allow_loopback = false;
    let mut ca_cert: Option<PathBuf> = None;
    let mut ca_key: Option<PathBuf> = None;
    let mut ikev2: Option<SocketAddr> = None;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
            None => (arg, None),
        };
        if flag == "--unsafe-allow-loopback" {
            allow_loopback = true;
            continue;
        }
        let value = match inline {
            Some(value) => value,
            None => iter
                .next()
                .ok_or_else(|| anyhow!("{flag} needs a value"))?,
        };
        match flag.as_str() {
            "--wireguard" => {
                wireguard = Some(value.parse().with_context(|| format!("bad --wireguard {value:?}"))?)
            }
            "--state" => state = Some(PathBuf::from(value)),
            "--socks" => socks = Some(value),
            "--endpoint-host" => endpoint_host = Some(value),
            "--tunnel-net" => tunnel_net = TunnelNet::parse(&value)?,
            "--quic" => {
                quic = QuicMode::parse(&value)
                    .ok_or_else(|| anyhow!("--quic must be block, relay or decrypt, got {value:?}"))?
            }
            "--ca-cert" => ca_cert = Some(PathBuf::from(value)),
            "--ca-key" => ca_key = Some(PathBuf::from(value)),
            "--ikev2" => ikev2 = Some(value.parse().with_context(|| format!("bad --ikev2 {value:?}"))?),
            other => bail!("unknown option {other}"),
        }
    }

    Ok(TunnelConfig {
        wireguard: wireguard.ok_or_else(|| anyhow!("--wireguard is required"))?,
        state_path: state.ok_or_else(|| anyhow!("--state is required"))?,
        socks: socks.ok_or_else(|| anyhow!("--socks is required"))?,
        endpoint_host,
        tunnel_net,
        quic,
        allow_loopback,
        ca_cert,
        ca_key,
        ikev2,
    })
}

fn handle_command(tunnel: &Tunnel, events: &EventSink, line: &str) {
    let command: Value = match serde_json::from_str(line) {
        Ok(command) => command,
        Err(error) => return events.error(format!("bad command JSON: {error}")),
    };
    let text = |key: &str| command.get(key).and_then(Value::as_str);

    // The network tools' commands (set-conditions, set-dns-rules, set-quic, capture-*).
    match tunnel.handle_tool_command(&command) {
        Some(Ok(reply)) => return events.emit(reply),
        Some(Err(error)) => return events.error(format!("{} failed: {error:#}", text("cmd").unwrap_or("command"))),
        None => {}
    }

    match text("cmd") {
        Some("add-peer") => {
            let name = text("name").unwrap_or("Phone");
            let kind = text("kind").unwrap_or(PEER_KIND_WIREGUARD);
            match tunnel.add_peer(name, kind) {
                Ok(added) => events.emit(added.to_event()),
                Err(error) => events.error(format!("add-peer failed: {error:#}")),
            }
        }
        Some("remove-peer") => match text("peer") {
            Some(peer) => match tunnel.remove_peer(peer) {
                Ok(()) => events.emit(serde_json::json!({ "event": "peer-removed", "peer": peer })),
                Err(error) => events.error(format!("remove-peer failed: {error:#}")),
            },
            None => events.error("remove-peer needs \"peer\""),
        },
        Some("list-peers") => events.emit(tunnel.list_peers()),
        Some("stats") => events.emit(tunnel.stats()),
        Some("set-socks") => match text("addr") {
            Some(addr) => match tunnel.set_socks(addr) {
                Ok(()) => events.emit(serde_json::json!({ "event": "socks-set", "addr": addr })),
                Err(error) => events.error(format!("set-socks failed: {error:#}")),
            },
            None => events.error("set-socks needs \"addr\""),
        },
        Some(other) => events.error(format!("unknown command {other:?}")),
        None => events.error("a command needs a \"cmd\" field"),
    }
}

async fn run(events: &EventSink) -> Result<()> {
    let config = parse_args(std::env::args().skip(1).collect())?;
    let mut tunnel = Tunnel::start(config, events.clone()).await?;
    let mut frontend = tunnel
        .take_frontend_task()
        .ok_or_else(|| anyhow!("the front-end task is missing"))?;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let outcome = loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) if line.trim().is_empty() => {}
                Ok(Some(line)) => {
                    // One command that panics must not take the whole VPN down with it.
                    let handled = catch_unwind(AssertUnwindSafe(|| handle_command(&tunnel, events, &line)));
                    if handled.is_err() {
                        events.error("a command panicked and was dropped");
                    }
                }
                // The parent closed our stdin (or died): quit, so the sidecar can't outlive it.
                Ok(None) => break Ok(()),
                Err(error) => break Err(anyhow!("cannot read stdin: {error}")),
            },
            ended = &mut frontend => {
                break Err(match ended {
                    Ok(Ok(())) => anyhow!("the tunnel stopped"),
                    Ok(Err(error)) => error.context("the tunnel stopped"),
                    Err(error) => anyhow!("the tunnel task failed: {error}"),
                });
            }
        }
    };
    // Every way out goes through here: main() ends with process::exit, which runs no destructors, so
    // a running capture is finished (and reported) first or its last packets are lost.
    tunnel.shutdown().await;
    outcome
}

#[tokio::main]
async fn main() {
    init_logger();
    let events = EventSink::stdout();
    let code = match run(&events).await {
        Ok(()) => 0,
        Err(error) => {
            events.error(format!("{error:#}"));
            eprintln!("wirepane-tunnel: {error:#}\n{USAGE}");
            1
        }
    };
    // Exit explicitly: tokio's stdin reader thread would otherwise keep the process alive.
    std::process::exit(code);
}
