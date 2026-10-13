//! The DNS server on the tunnel's DNS address (UDP and TCP port 53).
//!
//! Names are resolved on the host (the system resolver), so the phone gets the answers the Mac
//! would get. Only A records carry answers: AAAA and every other type get an empty NOERROR answer
//! (IPv6 is off in v1), `wirepane.cert` gets the virtual certificate address.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use mitmproxy::messages::TransportCommand;
use serde_json::json;
use tokio::time::timeout;

use super::{Core, Flow};
use crate::features::dns_rules::DnsAction;
use crate::frontend::PeerView;

const RCODE_NOERROR: u8 = 0;
const RCODE_FORMERR: u8 = 1;
const RCODE_SERVFAIL: u8 = 2;
const RCODE_NXDOMAIN: u8 = 3;
const RCODE_NOTIMP: u8 = 4;

const TYPE_A: u16 = 1;
const CLASS_IN: u16 = 1;
const ANSWER_TTL: u32 = 30;
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ANSWERS: usize = 16;
pub const CERT_HOST: &str = "wirepane.cert";

#[derive(Debug)]
pub struct Question {
    pub id: u16,
    pub flags: u16,
    pub name: String,
    pub qtype: u16,
    pub qclass: u16,
    question_end: usize,
}

#[derive(Debug)]
pub enum Parsed {
    Ok(Question),
    /// The header is readable but the question isn't: answer FORMERR.
    Malformed { id: u16, flags: u16 },
    /// Not a query we can answer at all (too short, or a response).
    Ignore,
}

pub fn parse_query(buf: &[u8]) -> Parsed {
    if buf.len() < 12 {
        return Parsed::Ignore;
    }
    let id = u16::from_be_bytes([buf[0], buf[1]]);
    let flags = u16::from_be_bytes([buf[2], buf[3]]);
    let question_count = u16::from_be_bytes([buf[4], buf[5]]);
    let is_response = flags & 0x8000 != 0;
    if is_response {
        return Parsed::Ignore;
    }
    let opcode = (flags >> 11) & 0x0F;
    if opcode != 0 || question_count == 0 {
        return Parsed::Malformed { id, flags };
    }
    let Some((name, after_name)) = parse_name(buf, 12) else {
        return Parsed::Malformed { id, flags };
    };
    let Some(tail) = buf.get(after_name..after_name + 4) else {
        return Parsed::Malformed { id, flags };
    };
    Parsed::Ok(Question {
        id,
        flags,
        name,
        qtype: u16::from_be_bytes([tail[0], tail[1]]),
        qclass: u16::from_be_bytes([tail[2], tail[3]]),
        question_end: after_name + 4,
    })
}

/// Reads a question name (no compression pointers allowed there). Returns the lower-case dotted
/// name and the position after it, or None for anything odd, so the name is safe to put in a tag.
fn parse_name(buf: &[u8], mut pos: usize) -> Option<(String, usize)> {
    let mut name = String::new();
    loop {
        let len = usize::from(*buf.get(pos)?);
        pos += 1;
        if len == 0 {
            return Some((name, pos));
        }
        if len > 63 {
            return None;
        }
        let label = buf.get(pos..pos + len)?;
        pos += len;
        if !name.is_empty() {
            name.push('.');
        }
        for &byte in label {
            let c = char::from(byte).to_ascii_lowercase();
            if !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '*') {
                return None;
            }
            name.push(c);
        }
        if name.len() > 253 {
            return None;
        }
    }
}

fn response_header(id: u16, query_flags: u16, rcode: u8, question: bool, answers: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&id.to_be_bytes());
    // QR, copy the RD bit, RA, and the response code.
    let flags = 0x8000 | (query_flags & 0x0100) | 0x0080 | u16::from(rcode & 0x0F);
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&u16::from(question).to_be_bytes());
    out.extend_from_slice(&u16::try_from(answers).unwrap_or(0).to_be_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out
}

pub fn build_response(query: &[u8], q: &Question, rcode: u8, answers: &[Ipv4Addr]) -> Vec<u8> {
    let mut out = response_header(q.id, q.flags, rcode, true, answers.len());
    out.extend_from_slice(&query[12..q.question_end]);
    for ip in answers {
        // Name as a pointer to the question, type A, class IN, TTL, 4 bytes of address.
        out.extend_from_slice(&[0xC0, 0x0C, 0, 1, 0, 1]);
        out.extend_from_slice(&ANSWER_TTL.to_be_bytes());
        out.extend_from_slice(&[0, 4]);
        out.extend_from_slice(&ip.octets());
    }
    out
}

pub fn qtype_name(qtype: u16) -> String {
    match qtype {
        1 => "A".into(),
        2 => "NS".into(),
        5 => "CNAME".into(),
        6 => "SOA".into(),
        12 => "PTR".into(),
        15 => "MX".into(),
        16 => "TXT".into(),
        28 => "AAAA".into(),
        33 => "SRV".into(),
        64 => "SVCB".into(),
        65 => "HTTPS".into(),
        255 => "ANY".into(),
        other => format!("TYPE{other}"),
    }
}

fn rcode_name(rcode: u8) -> &'static str {
    match rcode {
        RCODE_NOERROR => "NOERROR",
        RCODE_FORMERR => "FORMERR",
        RCODE_SERVFAIL => "SERVFAIL",
        RCODE_NXDOMAIN => "NXDOMAIN",
        RCODE_NOTIMP => "NOTIMP",
        _ => "OTHER",
    }
}

struct Resolution {
    rcode: u8,
    answers: Vec<Ipv4Addr>,
}

async fn resolve(name: &str, q: &Question, cert_ip: Ipv4Addr) -> Resolution {
    let empty = |rcode| Resolution {
        rcode,
        answers: Vec::new(),
    };
    if q.qclass != CLASS_IN {
        return empty(RCODE_NOTIMP);
    }
    // AAAA (IPv6 is off in v1), HTTPS, SVCB, TXT ...: an empty answer makes clients fall back to A.
    if q.qtype != TYPE_A || name.is_empty() {
        return empty(RCODE_NOERROR);
    }
    if name == CERT_HOST {
        return Resolution {
            rcode: RCODE_NOERROR,
            answers: vec![cert_ip],
        };
    }
    match timeout(LOOKUP_TIMEOUT, tokio::net::lookup_host((name, 0))).await {
        Ok(Ok(found)) => {
            let mut answers: Vec<Ipv4Addr> = Vec::new();
            for addr in found {
                if let IpAddr::V4(ip) = addr.ip()
                    && !answers.contains(&ip)
                    && answers.len() < MAX_ANSWERS
                {
                    answers.push(ip);
                }
            }
            Resolution {
                rcode: RCODE_NOERROR,
                answers,
            }
        }
        Ok(Err(_)) => empty(RCODE_NXDOMAIN),
        Err(_) => empty(RCODE_SERVFAIL),
    }
}

/// Answers one DNS message. None means "stay silent" (not a query).
pub async fn answer(core: &Core, peer: &PeerView, src_ip: Ipv4Addr, query: &[u8]) -> Option<Vec<u8>> {
    let started = Instant::now();
    let question = match parse_query(query) {
        Parsed::Ok(question) => question,
        Parsed::Malformed { id, flags } => {
            return Some(response_header(id, flags, RCODE_FORMERR, false, 0));
        }
        Parsed::Ignore => return None,
    };
    core.stats.dns_queries.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // The user's DNS rules come first: a blocked name doesn't exist, an answered one gets the
    // rule's address, and neither is looked up for real.
    let rule = core.hooks.dns_decide(&question.name);
    let resolution = match &rule {
        Some(action) => resolve_by_rule(action, &question),
        None => resolve(&question.name, &question, core.cfg.net.cert_ip()).await,
    };
    if question.qtype == TYPE_A && !resolution.answers.is_empty() {
        core.remember_name(src_ip, &question.name, &resolution.answers);
    }
    let mut event = json!({
        "event": "dns",
        "peer": peer.id,
        "name": question.name,
        "qtype": qtype_name(question.qtype),
        "rcode": rcode_name(resolution.rcode),
        "answers": resolution.answers.iter().map(|ip| ip.to_string()).collect::<Vec<_>>(),
        "ms": started.elapsed().as_millis() as u64,
    });
    if let (Some(action), Some(object)) = (&rule, event.as_object_mut()) {
        let mark = match action {
            DnsAction::Block => "blocked",
            DnsAction::Answer(_) => "answered",
        };
        object.insert("rule".into(), mark.into());
    }
    core.events.emit(event);
    Some(build_response(query, &question, resolution.rcode, &resolution.answers))
}

/// The answer a DNS rule gives: NXDOMAIN for a blocked name (every type), the rule's address for
/// an A question, and an empty answer for other types, so the real address can't leak through
/// AAAA or HTTPS records.
fn resolve_by_rule(action: &DnsAction, q: &Question) -> Resolution {
    match action {
        DnsAction::Block => Resolution { rcode: RCODE_NXDOMAIN, answers: Vec::new() },
        DnsAction::Answer(ip) if q.qtype == TYPE_A && q.qclass == CLASS_IN => {
            Resolution { rcode: RCODE_NOERROR, answers: vec![*ip] }
        }
        DnsAction::Answer(_) => Resolution { rcode: RCODE_NOERROR, answers: Vec::new() },
    }
}

/// UDP flow to the DNS address: one datagram in, one datagram out.
pub async fn udp_flow(core: &Arc<Core>, flow: &Flow, peer: &PeerView, src_ip: Ipv4Addr) {
    let mut removed = peer.removed.clone();
    loop {
        let Some(read) = flow.read(u32::from(u16::MAX)) else {
            return;
        };
        let datagram = tokio::select! {
            data = read => match data {
                Ok(data) => data,
                Err(_) => return,
            },
            _ = removed.changed() => return,
        };
        // Each query gets its own task, so a slow lookup doesn't hold up the others.
        let core = core.clone();
        let peer = peer.clone();
        let commands = flow.commands.clone();
        let id = flow.id;
        tokio::spawn(async move {
            if let Some(response) = answer(&core, &peer, src_ip, &datagram).await {
                commands.send(TransportCommand::WriteData(id, response)).ok();
            }
        });
    }
}

/// TCP flow to the DNS address: messages are prefixed with their 2-byte length.
pub async fn tcp_flow(core: &Arc<Core>, flow: &Flow, peer: &PeerView, src_ip: Ipv4Addr) -> Result<()> {
    let mut removed = peer.removed.clone();
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        while buffer.len() < 2 || buffer.len() < 2 + usize::from(u16::from_be_bytes([buffer[0], buffer[1]])) {
            let Some(read) = flow.read(4096) else {
                return Ok(());
            };
            let chunk = tokio::select! {
                data = read => match data {
                    Ok(data) => data,
                    Err(_) => return Ok(()),
                },
                _ = removed.changed() => return Ok(()),
            };
            if chunk.is_empty() {
                return Ok(());
            }
            buffer.extend_from_slice(&chunk);
            if buffer.len() > 2 * 1024 * 1024 {
                bail!("DNS over TCP: too much buffered data");
            }
        }
        let length = usize::from(u16::from_be_bytes([buffer[0], buffer[1]]));
        let query: Vec<u8> = buffer[2..2 + length].to_vec();
        buffer.drain(..2 + length);
        if let Some(response) = answer(core, peer, src_ip, &query).await {
            let Ok(response_len) = u16::try_from(response.len()) else {
                continue;
            };
            let mut framed = response_len.to_be_bytes().to_vec();
            framed.extend_from_slice(&response);
            if !flow.write(framed) || !flow.drain().await {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(name: &str, qtype: u16) -> Vec<u8> {
        let mut q = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in name.split('.') {
            q.push(label.len() as u8);
            q.extend_from_slice(label.as_bytes());
        }
        q.push(0);
        q.extend_from_slice(&qtype.to_be_bytes());
        q.extend_from_slice(&1u16.to_be_bytes());
        q
    }

    #[test]
    fn parses_a_normal_query() {
        let q = query("Example.COM", 1);
        let Parsed::Ok(parsed) = parse_query(&q) else {
            panic!("should parse");
        };
        assert_eq!(parsed.name, "example.com");
        assert_eq!(parsed.qtype, 1);
        assert_eq!(parsed.id, 0x1234);
    }

    #[test]
    fn builds_an_answer_with_a_pointer() {
        let q = query("a.test", 1);
        let Parsed::Ok(parsed) = parse_query(&q) else {
            panic!("should parse");
        };
        let response = build_response(&q, &parsed, 0, &[Ipv4Addr::new(1, 2, 3, 4)]);
        assert_eq!(&response[..2], &[0x12, 0x34]);
        assert_eq!(response[3] & 0x0F, 0);
        assert_eq!(u16::from_be_bytes([response[6], response[7]]), 1);
        assert_eq!(&response[response.len() - 4..], &[1, 2, 3, 4]);
    }

    #[test]
    fn rules_block_with_nxdomain_and_answer_only_a_questions() {
        let a = query("api.test", 1);
        let Parsed::Ok(a) = parse_query(&a) else { panic!("should parse") };
        let aaaa = query("api.test", 28);
        let Parsed::Ok(aaaa) = parse_query(&aaaa) else { panic!("should parse") };
        let ip = Ipv4Addr::new(192, 168, 0, 10);

        let blocked = resolve_by_rule(&DnsAction::Block, &a);
        assert_eq!((blocked.rcode, blocked.answers.len()), (RCODE_NXDOMAIN, 0));
        let blocked = resolve_by_rule(&DnsAction::Block, &aaaa);
        assert_eq!(blocked.rcode, RCODE_NXDOMAIN, "a blocked name doesn't exist for any type");

        let answered = resolve_by_rule(&DnsAction::Answer(ip), &a);
        assert_eq!((answered.rcode, answered.answers), (RCODE_NOERROR, vec![ip]));
        let answered = resolve_by_rule(&DnsAction::Answer(ip), &aaaa);
        assert_eq!((answered.rcode, answered.answers.len()), (RCODE_NOERROR, 0));
    }

    #[test]
    fn garbage_never_panics() {
        for len in 0..40 {
            let junk: Vec<u8> = (0..len).map(|i| (i * 37 % 251) as u8).collect();
            let _ = parse_query(&junk);
        }
        // A label that runs past the end, and a compression pointer inside the question.
        let mut broken = query("a.test", 1);
        broken[12] = 60;
        assert!(matches!(parse_query(&broken), Parsed::Malformed { .. }));
        let mut pointer = query("a.test", 1);
        pointer[12] = 0xC0;
        assert!(matches!(parse_query(&pointer), Parsed::Malformed { .. }));
    }
}
