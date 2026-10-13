//! JA4 fingerprints (T5): what a TLS ClientHello says about the app that sent it.
//!
//! The core feeds the first bytes a phone sent on every TCP flow to [`inspect_client_hello`]
//! (or [`parse_client_hello`] when it only wants the answer). Pinned apps are covered too: the
//! ClientHello travels in the clear before any certificate is checked.
//!
//! The JA4 string follows the FoxIO spec (github.com/FoxIO-LLC/ja4, technical_details/JA4.md):
//!
//! ```text
//! t13d1516h2_8daaf6152771_e5627efa2ab1
//! |||||||||| |            |
//! |||||||||| |            +-- first 12 hex chars of SHA-256 over the extension types sorted,
//! |||||||||| |                without SNI (0000) and ALPN (0010), then "_" and the signature
//! |||||||||| |                algorithms in the order the client sent them
//! |||||||||| +-- first 12 hex chars of SHA-256 over the cipher suites, sorted
//! |||||||||+-- first and last character of the first ALPN value ("00" when there is none)
//! |||||||++-- number of extensions (SNI and ALPN count, capped at 99)
//! |||||++-- number of cipher suites (capped at 99)
//! ||||+-- "d" when the SNI extension is there, "i" when it is not
//! |++-- TLS version: the highest in supported_versions, else the hello's own version
//! +-- "t" for TCP
//! ```
//!
//! GREASE values (RFC 8701) are left out of every count and hash (the signature algorithms
//! included), so a browser keeps one fingerprint although it picks new GREASE values for each
//! connection.

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsHello {
    pub sni: Option<String>,
    pub alpn: Vec<String>,
    /// The JA4 string, e.g. `t13d1516h2_8daaf6152771_02713d6af862`.
    pub ja4: String,
}

/// How far the first bytes of a flow got towards a TLS ClientHello. It lets the core stop
/// waiting at once for a flow that is plain HTTP or SSH, and keep reading for one whose
/// (post-quantum, ~1.5 KB) hello arrives in two TCP segments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelloProgress {
    /// Not the start of a TLS handshake. More bytes won't change that.
    NotTls,
    /// A ClientHello so far, but the rest hasn't arrived yet.
    NeedMore,
    /// A complete ClientHello.
    Hello(TlsHello),
}

/// Parses the first bytes a client sent on a TCP flow. None when they aren't a complete TLS
/// ClientHello (another protocol, or not all of it arrived yet).
pub fn parse_client_hello(first_bytes: &[u8]) -> Option<TlsHello> {
    match inspect_client_hello(first_bytes) {
        HelloProgress::Hello(hello) => Some(hello),
        HelloProgress::NotTls | HelloProgress::NeedMore => None,
    }
}

/// Like [`parse_client_hello`], but tells "not TLS" apart from "not complete yet".
pub fn inspect_client_hello(first_bytes: &[u8]) -> HelloProgress {
    match collect_handshake_message(first_bytes) {
        Ok(message) => match parse_hello_body(&message) {
            Some(parsed) => HelloProgress::Hello(parsed.into_tls_hello()),
            // The whole message is here and still makes no sense, so waiting won't help
            None => HelloProgress::NotTls,
        },
        Err(Stop::Short) => HelloProgress::NeedMore,
        Err(Stop::Bad) => HelloProgress::NotTls,
    }
}

// ---------------------------------------------------------------------------------------------
// Record layer: find the handshake message (it may be spread over several records)
// ---------------------------------------------------------------------------------------------

const RECORD_HEADER_LEN: usize = 5;
const RECORD_TYPE_HANDSHAKE: u8 = 0x16;
const HANDSHAKE_CLIENT_HELLO: u8 = 0x01;
const HANDSHAKE_HEADER_LEN: usize = 4;
/// TLS limits a record's payload to 2^14 bytes.
const MAX_RECORD_PAYLOAD: usize = 16384;
/// No real ClientHello comes near this. It keeps one flow from making the sidecar buffer much.
const MAX_HANDSHAKE_LEN: usize = 65536;

enum Stop {
    /// The bytes so far are fine, there just aren't enough of them yet.
    Short,
    /// These bytes can't be a ClientHello.
    Bad,
}

/// Joins the handshake fragments of the leading records into one ClientHello message
/// (header included) and cuts off whatever follows it.
fn collect_handshake_message(bytes: &[u8]) -> Result<Vec<u8>, Stop> {
    let mut message: Vec<u8> = Vec::new();
    let mut pos = 0;

    loop {
        // Check each header byte as soon as it is here, so garbage is rejected on its first byte
        let header = &bytes[pos.min(bytes.len())..];
        if header.first().is_some_and(|&b| b != RECORD_TYPE_HANDSHAKE) {
            return Err(Stop::Bad);
        }
        if header.get(1).is_some_and(|&major| major != 3) {
            return Err(Stop::Bad);
        }
        // Record versions go from 3.0 (SSL 3.0) to 3.4; real clients send 3.1 or 3.3
        if header.get(2).is_some_and(|&minor| minor > 4) {
            return Err(Stop::Bad);
        }
        if header.len() < RECORD_HEADER_LEN {
            return Err(Stop::Short);
        }

        let payload_len = usize::from(u16::from_be_bytes([header[3], header[4]]));
        if payload_len == 0 || payload_len > MAX_RECORD_PAYLOAD {
            return Err(Stop::Bad);
        }
        let Some(payload) = header.get(RECORD_HEADER_LEN..RECORD_HEADER_LEN + payload_len) else {
            return Err(Stop::Short);
        };
        message.extend_from_slice(payload);
        pos += RECORD_HEADER_LEN + payload_len;

        if message.first().is_some_and(|&kind| kind != HANDSHAKE_CLIENT_HELLO) {
            return Err(Stop::Bad);
        }
        if message.len() < HANDSHAKE_HEADER_LEN {
            continue;
        }

        let body_len = (usize::from(message[1]) << 16) | (usize::from(message[2]) << 8) | usize::from(message[3]);
        let total_len = HANDSHAKE_HEADER_LEN + body_len;
        if total_len > MAX_HANDSHAKE_LEN {
            return Err(Stop::Bad);
        }
        if message.len() >= total_len {
            message.truncate(total_len);
            return Ok(message);
        }
        // The message goes on in the next record
    }
}

// ---------------------------------------------------------------------------------------------
// ClientHello body
// ---------------------------------------------------------------------------------------------

const EXT_SERVER_NAME: u16 = 0x0000;
const EXT_ALPN: u16 = 0x0010;
const EXT_SIGNATURE_ALGORITHMS: u16 = 0x000d;
const EXT_SUPPORTED_VERSIONS: u16 = 0x002b;
const SNI_HOST_NAME: u8 = 0;
/// DNS names are at most 253 characters
const MAX_SNI_LEN: usize = 255;

struct Reader<'a> {
    data: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data }
    }

    fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        if self.data.len() < len {
            return None;
        }
        let (taken, rest) = self.data.split_at(len);
        self.data = rest;
        Some(taken)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|bytes| bytes[0])
    }

    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
    }
}

/// What the fingerprint needs from a ClientHello, in the order the client sent it.
#[derive(Debug, Default)]
struct ParsedHello {
    legacy_version: u16,
    cipher_suites: Vec<u16>,
    extension_types: Vec<u16>,
    sni: Option<String>,
    alpn: Vec<Vec<u8>>,
    signature_algorithms: Vec<u16>,
    supported_versions: Vec<u16>,
}

/// `message` is the whole handshake message, header included.
fn parse_hello_body(message: &[u8]) -> Option<ParsedHello> {
    let mut reader = Reader::new(message.get(HANDSHAKE_HEADER_LEN..)?);
    let mut hello = ParsedHello { legacy_version: reader.u16()?, ..ParsedHello::default() };

    reader.take(32)?; // random
    let session_id_len = usize::from(reader.u8()?);
    reader.take(session_id_len)?;

    let cipher_bytes_len = usize::from(reader.u16()?);
    if cipher_bytes_len == 0 || cipher_bytes_len % 2 != 0 {
        return None;
    }
    hello.cipher_suites = reader
        .take(cipher_bytes_len)?
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();

    let compression_len = usize::from(reader.u8()?);
    reader.take(compression_len)?;

    // SSL 3.0 and old TLS hellos may end here, without extensions
    if reader.is_empty() {
        return Some(hello);
    }
    let extensions_len = usize::from(reader.u16()?);
    let mut extensions = Reader::new(reader.take(extensions_len)?);

    while !extensions.is_empty() {
        let extension_type = extensions.u16()?;
        let data_len = usize::from(extensions.u16()?);
        let data = extensions.take(data_len)?;
        hello.extension_types.push(extension_type);

        // The bodies are read leniently: a broken SNI or ALPN list costs only its own field
        match extension_type {
            EXT_SERVER_NAME => hello.sni = parse_server_name(data),
            EXT_ALPN => hello.alpn = parse_alpn(data).unwrap_or_default(),
            EXT_SIGNATURE_ALGORITHMS => hello.signature_algorithms = parse_u16_list(data, ListLen::U16).unwrap_or_default(),
            EXT_SUPPORTED_VERSIONS => hello.supported_versions = parse_u16_list(data, ListLen::U8).unwrap_or_default(),
            _ => {}
        }
    }

    Some(hello)
}

fn parse_server_name(data: &[u8]) -> Option<String> {
    let mut reader = Reader::new(data);
    let list_len = usize::from(reader.u16()?);
    let mut list = Reader::new(reader.take(list_len)?);

    while !list.is_empty() {
        let name_type = list.u8()?;
        let name_len = usize::from(list.u16()?);
        let name = list.take(name_len)?;
        if name_type != SNI_HOST_NAME {
            continue;
        }
        // The name ends up in tags and the UI: only visible ASCII passes (hostnames always are)
        let is_hostname = !name.is_empty() && name.len() <= MAX_SNI_LEN && name.iter().all(|byte| byte.is_ascii_graphic());
        return is_hostname.then(|| String::from_utf8_lossy(name).into_owned());
    }
    None
}

fn parse_alpn(data: &[u8]) -> Option<Vec<Vec<u8>>> {
    let mut reader = Reader::new(data);
    let list_len = usize::from(reader.u16()?);
    let mut list = Reader::new(reader.take(list_len)?);

    let mut protocols = Vec::new();
    while !list.is_empty() {
        let len = usize::from(list.u8()?);
        protocols.push(list.take(len)?.to_vec());
    }
    Some(protocols)
}

/// How many bytes the length in front of a list takes: signature_algorithms has two,
/// supported_versions has one.
enum ListLen {
    U8,
    U16,
}

fn parse_u16_list(data: &[u8], list_len: ListLen) -> Option<Vec<u16>> {
    let mut reader = Reader::new(data);
    let len = match list_len {
        ListLen::U8 => usize::from(reader.u8()?),
        ListLen::U16 => usize::from(reader.u16()?),
    };
    let bytes = reader.take(len)?;
    Some(bytes.chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect())
}

// ---------------------------------------------------------------------------------------------
// JA4
// ---------------------------------------------------------------------------------------------

/// GREASE (RFC 8701): 0x0a0a, 0x1a1a ... 0xfafa. Clients sprinkle them in on purpose.
fn is_grease(value: u16) -> bool {
    let [high, low] = value.to_be_bytes();
    high == low && low & 0x0f == 0x0a
}

fn version_code(version: u16) -> &'static str {
    match version {
        0x0304 => "13",
        0x0303 => "12",
        0x0302 => "11",
        0x0301 => "10",
        0x0300 => "s3",
        0x0200 => "s2",
        0xfeff => "d1",
        0xfefd => "d2",
        0xfefc => "d3",
        _ => "00",
    }
}

/// First and last character of the first ALPN value. A value that doesn't start and end with
/// a letter or digit is shown as the first and last character of its hex form instead.
fn alpn_code(alpn: &[Vec<u8>]) -> String {
    let Some(first) = alpn.first() else { return "00".to_string() };
    let (Some(&head), Some(&tail)) = (first.first(), first.last()) else { return "00".to_string() };

    if head.is_ascii_alphanumeric() && tail.is_ascii_alphanumeric() {
        return format!("{}{}", char::from(head), char::from(tail));
    }
    let hex: String = first.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut chars = hex.chars();
    let (head, tail) = (chars.next().unwrap_or('0'), chars.next_back().unwrap_or('0'));
    format!("{head}{tail}")
}

fn hex_list(values: &[u16]) -> String {
    values.iter().map(|value| format!("{value:04x}")).collect::<Vec<_>>().join(",")
}

/// First 12 hex characters of the SHA-256, or twelve zeros for an empty list.
fn hash12(text: &str) -> String {
    if text.is_empty() {
        return "0".repeat(12);
    }
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect()
}

/// The three parts of a JA4 before the two hashes are taken: `a`, the sorted cipher list and
/// the sorted extension list (with the signature algorithms behind it).
struct Ja4Parts {
    a: String,
    ciphers: String,
    extensions: String,
}

impl Ja4Parts {
    fn hashed(&self) -> String {
        format!("{}_{}_{}", self.a, hash12(&self.ciphers), hash12(&self.extensions))
    }

    /// JA4_r from the spec: the same string with the lists in place of the hashes.
    #[cfg(test)]
    fn raw(&self) -> String {
        format!("{}_{}_{}", self.a, self.ciphers, self.extensions)
    }
}

impl ParsedHello {
    fn ja4_parts(&self) -> Ja4Parts {
        let mut ciphers: Vec<u16> = self.cipher_suites.iter().copied().filter(|&c| !is_grease(c)).collect();
        let extension_count = self.extension_types.iter().filter(|&&e| !is_grease(e)).count();
        // SNI and ALPN count towards the number of extensions, but are not part of the hash
        let mut hashed_extensions: Vec<u16> = self
            .extension_types
            .iter()
            .copied()
            .filter(|&e| !is_grease(e) && e != EXT_SERVER_NAME && e != EXT_ALPN)
            .collect();
        let has_sni = self.extension_types.contains(&EXT_SERVER_NAME);

        let highest_version = self.supported_versions.iter().copied().filter(|&v| !is_grease(v)).max();
        let version = version_code(highest_version.unwrap_or(self.legacy_version));

        let a = format!(
            "t{version}{sni}{cipher_count:02}{extension_count:02}{alpn}",
            sni = if has_sni { 'd' } else { 'i' },
            cipher_count = ciphers.len().min(99),
            extension_count = extension_count.min(99),
            alpn = alpn_code(&self.alpn),
        );

        ciphers.sort_unstable();
        hashed_extensions.sort_unstable();
        let mut extensions = hex_list(&hashed_extensions);
        // The signature algorithms keep the client's order. Chrome 154 puts a GREASE value in
        // front of them, and it would give every connection its own fingerprint if it counted.
        let signature_algorithms: Vec<u16> = self.signature_algorithms.iter().copied().filter(|&a| !is_grease(a)).collect();
        if !signature_algorithms.is_empty() {
            extensions.push('_');
            extensions.push_str(&hex_list(&signature_algorithms));
        }

        Ja4Parts { a, ciphers: hex_list(&ciphers), extensions }
    }

    fn into_tls_hello(self) -> TlsHello {
        let alpn = self
            .alpn
            .iter()
            .map(|protocol| String::from_utf8_lossy(protocol).chars().filter(|c| !c.is_control()).collect())
            .collect();

        TlsHello { sni: self.sni.clone(), alpn, ja4: self.ja4_parts().hashed() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- building ClientHellos -------------------------------------------------------------

    fn u16_bytes(value: u16) -> [u8; 2] {
        value.to_be_bytes()
    }

    fn extension(kind: u16, body: &[u8]) -> Vec<u8> {
        let mut out = u16_bytes(kind).to_vec();
        out.extend(u16_bytes(body.len() as u16));
        out.extend(body);
        out
    }

    fn sni_extension(name: &str) -> Vec<u8> {
        let mut entry = vec![SNI_HOST_NAME];
        entry.extend(u16_bytes(name.len() as u16));
        entry.extend(name.as_bytes());
        let mut body = u16_bytes(entry.len() as u16).to_vec();
        body.extend(entry);
        extension(EXT_SERVER_NAME, &body)
    }

    fn alpn_extension(protocols: &[&[u8]]) -> Vec<u8> {
        let list: Vec<u8> = protocols.iter().flat_map(|p| [vec![p.len() as u8], p.to_vec()].concat()).collect();
        let mut body = u16_bytes(list.len() as u16).to_vec();
        body.extend(list);
        extension(EXT_ALPN, &body)
    }

    fn signature_algorithms_extension(algorithms: &[u16]) -> Vec<u8> {
        let list: Vec<u8> = algorithms.iter().flat_map(|a| u16_bytes(*a)).collect();
        let mut body = u16_bytes(list.len() as u16).to_vec();
        body.extend(list);
        extension(EXT_SIGNATURE_ALGORITHMS, &body)
    }

    fn supported_versions_extension(versions: &[u16]) -> Vec<u8> {
        let list: Vec<u8> = versions.iter().flat_map(|v| u16_bytes(*v)).collect();
        let mut body = vec![list.len() as u8];
        body.extend(list);
        extension(EXT_SUPPORTED_VERSIONS, &body)
    }

    /// An extension this module doesn't read, with some filler bytes in it
    fn other_extension(kind: u16) -> Vec<u8> {
        extension(kind, &[0x5a; 6])
    }

    struct HelloSpec {
        legacy_version: u16,
        cipher_suites: Vec<u16>,
        extensions: Vec<Vec<u8>>,
    }

    impl HelloSpec {
        /// The handshake message: header and body
        fn handshake_message(&self) -> Vec<u8> {
            let mut body = u16_bytes(self.legacy_version).to_vec();
            body.extend([0x11; 32]); // random
            body.push(32); // session id
            body.extend([0x22; 32]);
            body.extend(u16_bytes((self.cipher_suites.len() * 2) as u16));
            body.extend(self.cipher_suites.iter().flat_map(|c| u16_bytes(*c)));
            body.extend([1, 0]); // compression: null only
            let extensions: Vec<u8> = self.extensions.concat();
            body.extend(u16_bytes(extensions.len() as u16));
            body.extend(extensions);

            let mut message = vec![HANDSHAKE_CLIENT_HELLO, 0, (body.len() >> 8) as u8, body.len() as u8];
            message.extend(body);
            message
        }

        /// One TLS record holding the whole hello
        fn record(&self) -> Vec<u8> {
            wrap_in_records(&self.handshake_message(), usize::MAX)
        }
    }

    /// Cuts `message` into records of at most `max_payload` bytes
    fn wrap_in_records(message: &[u8], max_payload: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in message.chunks(max_payload.min(MAX_RECORD_PAYLOAD)) {
            out.extend([RECORD_TYPE_HANDSHAKE, 3, 1]);
            out.extend(u16_bytes(chunk.len() as u16));
            out.extend(chunk);
        }
        out
    }

    /// Chrome's cipher suites in its wire order, a GREASE value first
    fn chrome_ciphers() -> Vec<u16> {
        vec![
            0x0a0a, 0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c,
            0x009d, 0x002f, 0x0035,
        ]
    }

    const CHROME_SIGNATURE_ALGORITHMS: [u16; 8] = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601];

    /// A Chrome-shaped hello for `h2` and `http/1.1` with the given non-GREASE extension types
    /// besides SNI and ALPN (in the order given), GREASE extensions at both ends like Chrome.
    fn chrome_like(host: &str, other_types: &[u16]) -> HelloSpec {
        chrome_like_with_signature_algorithms(host, other_types, &CHROME_SIGNATURE_ALGORITHMS)
    }

    fn chrome_like_with_signature_algorithms(host: &str, other_types: &[u16], signature_algorithms: &[u16]) -> HelloSpec {
        let mut extensions = vec![other_extension(0x1a1a), sni_extension(host)];
        for &kind in other_types {
            extensions.push(match kind {
                EXT_SIGNATURE_ALGORITHMS => signature_algorithms_extension(signature_algorithms),
                EXT_SUPPORTED_VERSIONS => supported_versions_extension(&[0x2a2a, 0x0304, 0x0303]),
                kind => other_extension(kind),
            });
        }
        extensions.push(alpn_extension(&[b"h2", b"http/1.1"]));
        extensions.push(other_extension(0x4a4a));

        HelloSpec { legacy_version: 0x0303, cipher_suites: chrome_ciphers(), extensions }
    }

    fn ja4_of(record: &[u8]) -> String {
        parse_client_hello(record).expect("a complete ClientHello").ja4
    }

    // ---- the spec's published examples -----------------------------------------------------

    // Chrome's extension sets and the JA4 each produced, as published by FoxIO and listed by
    // JA4 databases. All share the cipher hash 8daaf6152771.
    const CHROME_PADDING_ALPS: [u16; 14] = [
        0xff01, 0x0017, 0x000a, 0x000b, 0x0023, 0x0005, 0x000d, 0x0012, 0x0033, 0x002d, 0x002b, 0x001b, 0x4469, 0x0015,
    ];
    const CHROME_ECH_ALPS: [u16; 14] = [
        0xff01, 0x0017, 0x000a, 0x000b, 0x0023, 0x0005, 0x000d, 0x0012, 0x0033, 0x002d, 0x002b, 0x001b, 0x4469, 0xfe0d,
    ];
    const CHROME_ECH_NEW_ALPS: [u16; 14] = [
        0xff01, 0x0017, 0x000a, 0x000b, 0x0023, 0x0005, 0x000d, 0x0012, 0x0033, 0x002d, 0x002b, 0x001b, 0x44cd, 0xfe0d,
    ];
    const CHROME_RESUMING: [u16; 15] = [
        0xff01, 0x0017, 0x000a, 0x000b, 0x0023, 0x0005, 0x000d, 0x0012, 0x0033, 0x002d, 0x002b, 0x001b, 0x4469, 0xfe0d,
        0x0029,
    ];

    #[test]
    fn matches_the_published_chrome_ja4_with_padding() {
        let hello = chrome_like("example.com", &CHROME_PADDING_ALPS).record();
        assert_eq!(ja4_of(&hello), "t13d1516h2_8daaf6152771_e5627efa2ab1");
    }

    #[test]
    fn matches_the_published_chrome_ja4_with_ech() {
        let hello = chrome_like("example.com", &CHROME_ECH_ALPS).record();
        assert_eq!(ja4_of(&hello), "t13d1516h2_8daaf6152771_02713d6af862");
    }

    #[test]
    fn matches_the_published_chrome_ja4_with_the_new_alps_codepoint() {
        let hello = chrome_like("example.com", &CHROME_ECH_NEW_ALPS).record();
        assert_eq!(ja4_of(&hello), "t13d1516h2_8daaf6152771_d8a2da3f94cd");
    }

    #[test]
    fn matches_the_published_ja4_of_a_resuming_chrome() {
        let hello = chrome_like("example.com", &CHROME_RESUMING).record();
        assert_eq!(ja4_of(&hello), "t13d1517h2_8daaf6152771_b0da82dd1658");
    }

    #[test]
    fn raw_form_is_the_spec_s_ja4_r() {
        let message = chrome_like("example.com", &CHROME_PADDING_ALPS).handshake_message();
        let parts = parse_hello_body(&message).unwrap().ja4_parts();
        assert_eq!(
            parts.raw(),
            "t13d1516h2_002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9_\
             0005,000a,000b,000d,0012,0015,0017,001b,0023,002b,002d,0033,4469,ff01_\
             0403,0804,0401,0503,0805,0501,0806,0601"
        );
    }

    #[test]
    fn the_cipher_hash_is_the_published_one() {
        let sorted = "002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9";
        assert_eq!(hash12(sorted), "8daaf6152771");
    }

    // ---- what the fingerprint ignores or reads ---------------------------------------------

    #[test]
    fn extension_order_and_grease_values_change_nothing() {
        let plain = chrome_like("example.com", &CHROME_ECH_ALPS);

        // Chrome shuffles its extensions on every connection
        let mut shuffled_types = CHROME_ECH_ALPS;
        shuffled_types.reverse();
        let mut shuffled = chrome_like("example.com", &shuffled_types);
        shuffled.cipher_suites[0] = 0xdada; // another GREASE value
        shuffled.extensions[0] = other_extension(0x7a7a);

        assert_eq!(ja4_of(&plain.record()), ja4_of(&shuffled.record()));
    }

    #[test]
    fn grease_in_the_signature_algorithms_is_ignored() {
        let mut with_grease = vec![0xdada];
        with_grease.extend(CHROME_SIGNATURE_ALGORITHMS);
        let plain = chrome_like("example.com", &CHROME_ECH_ALPS).record();
        let greased = chrome_like_with_signature_algorithms("example.com", &CHROME_ECH_ALPS, &with_grease).record();
        assert_eq!(ja4_of(&greased), ja4_of(&plain));
        assert_eq!(ja4_of(&greased), "t13d1516h2_8daaf6152771_02713d6af862");
    }

    #[test]
    fn reads_the_sni_and_every_alpn_value() {
        let hello = parse_client_hello(&chrome_like("api.example.org", &CHROME_ECH_ALPS).record()).unwrap();
        assert_eq!(hello.sni.as_deref(), Some("api.example.org"));
        assert_eq!(hello.alpn, vec!["h2".to_string(), "http/1.1".to_string()]);
    }

    #[test]
    fn a_hello_without_sni_and_alpn_is_i_and_00() {
        let spec = HelloSpec {
            legacy_version: 0x0303,
            cipher_suites: vec![0x1301, 0xc02f],
            extensions: vec![supported_versions_extension(&[0x0304, 0x0303]), other_extension(0x0033)],
        };
        let hello = parse_client_hello(&spec.record()).unwrap();
        assert_eq!(hello.sni, None);
        assert!(hello.alpn.is_empty());
        assert!(hello.ja4.starts_with("t13i020200_"), "{}", hello.ja4);
    }

    #[test]
    fn a_tls_1_2_hello_takes_its_version_from_the_hello_itself() {
        let spec = HelloSpec {
            legacy_version: 0x0303,
            cipher_suites: vec![0xc02f, 0xc030],
            extensions: vec![sni_extension("old.example.com")],
        };
        let hello = parse_client_hello(&spec.record()).unwrap();
        assert!(hello.ja4.starts_with("t12d020100_"), "{}", hello.ja4);
        // No signature algorithms: the extension hash is over the (empty) list, so twelve zeros
        assert!(hello.ja4.ends_with("_000000000000"), "{}", hello.ja4);
    }

    #[test]
    fn a_hello_with_no_extensions_at_all_still_gets_a_ja4() {
        // An SSL 3.0 / early TLS style hello ends after the compression methods
        let mut message = vec![HANDSHAKE_CLIENT_HELLO, 0, 0, 0];
        message.extend(u16_bytes(0x0301));
        message.extend([0x33; 32]);
        message.push(0);
        message.extend(u16_bytes(4));
        message.extend([0x00, 0x2f, 0x00, 0x35]);
        message.extend([1, 0]);
        message[3] = (message.len() - HANDSHAKE_HEADER_LEN) as u8;

        let hello = parse_client_hello(&wrap_in_records(&message, usize::MAX)).unwrap();
        assert_eq!(hello.ja4, format!("t10i020000_{}_000000000000", hash12("002f,0035")));
    }

    #[test]
    fn counts_stop_at_99() {
        let spec = HelloSpec {
            legacy_version: 0x0303,
            cipher_suites: (0x0100..0x0100 + 120).collect(),
            extensions: (0x0100..0x0100 + 120).map(other_extension).collect(),
        };
        let hello = parse_client_hello(&spec.record()).unwrap();
        assert!(hello.ja4.starts_with("t12i999900_"), "{}", hello.ja4);
    }

    #[test]
    fn alpn_code_uses_hex_for_values_that_are_not_text() {
        assert_eq!(alpn_code(&[b"h2".to_vec()]), "h2");
        assert_eq!(alpn_code(&[b"http/1.1".to_vec(), b"h2".to_vec()]), "h1");
        assert_eq!(alpn_code(&[b"x".to_vec()]), "xx");
        assert_eq!(alpn_code(&[vec![0xab, 0xcd]]), "ad");
        assert_eq!(alpn_code(&[vec![0xab]]), "ab");
        assert_eq!(alpn_code(&[b"/a".to_vec()]), "21"); // 2f61: first and last hex character
        assert_eq!(alpn_code(&[]), "00");
        assert_eq!(alpn_code(&[vec![]]), "00");
    }

    #[test]
    fn grease_values_are_recognised() {
        for value in [0x0a0a, 0x1a1a, 0x2a2a, 0x7a7a, 0xdada, 0xfafa] {
            assert!(is_grease(value), "{value:04x}");
        }
        for value in [0x0000, 0x0a1a, 0x1301, 0xc02b, 0x0a0b, 0xaaab, 0xff01] {
            assert!(!is_grease(value), "{value:04x}");
        }
    }

    #[test]
    fn an_sni_that_is_not_a_hostname_is_dropped_but_still_flags_d() {
        let spec = HelloSpec {
            legacy_version: 0x0303,
            cipher_suites: vec![0x1301],
            extensions: vec![sni_extension("bad name\n,tag")],
        };
        let hello = parse_client_hello(&spec.record()).unwrap();
        assert_eq!(hello.sni, None);
        assert!(hello.ja4.starts_with("t12d0101"), "{}", hello.ja4);
    }

    // ---- not complete yet, and not TLS ---------------------------------------------------

    #[test]
    fn a_hello_split_over_several_records_is_put_together() {
        let spec = chrome_like("split.example.com", &CHROME_ECH_ALPS);
        let message = spec.handshake_message();
        let expected = ja4_of(&spec.record());

        for max_payload in [1, 7, 100, 301] {
            let records = wrap_in_records(&message, max_payload);
            let hello = parse_client_hello(&records).unwrap_or_else(|| panic!("records of {max_payload} bytes"));
            assert_eq!(hello.ja4, expected);
            assert_eq!(hello.sni.as_deref(), Some("split.example.com"));
        }
    }

    #[test]
    fn bytes_after_the_hello_are_ignored() {
        let mut bytes = chrome_like("example.com", &CHROME_ECH_ALPS).record();
        let expected = ja4_of(&bytes);
        bytes.extend([0x17, 0x03, 0x03, 0x00, 0x05, 1, 2, 3, 4, 5]);
        assert_eq!(ja4_of(&bytes), expected);
    }

    #[test]
    fn every_cut_short_hello_needs_more_bytes() {
        let record = chrome_like("example.com", &CHROME_ECH_ALPS).record();
        for len in 1..record.len() {
            assert_eq!(inspect_client_hello(&record[..len]), HelloProgress::NeedMore, "first {len} bytes");
            assert_eq!(parse_client_hello(&record[..len]), None);
        }
        assert!(matches!(inspect_client_hello(&record), HelloProgress::Hello(_)));
    }

    #[test]
    fn other_protocols_are_rejected_on_their_first_bytes() {
        let http = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
        let connect = b"CONNECT example.com:443 HTTP/1.1\r\n\r\n";
        let ssh = b"SSH-2.0-OpenSSH_9.6\r\n";
        let samples: [&[u8]; 6] = [http, connect, ssh, &[0x05, 0x01, 0x00], &[0x80, 0x2e, 0x01, 0x03, 0x01], &[0x00]];
        for sample in samples {
            assert_eq!(inspect_client_hello(&sample[..1]), HelloProgress::NotTls, "{sample:?}");
            assert_eq!(inspect_client_hello(sample), HelloProgress::NotTls, "{sample:?}");
            assert_eq!(parse_client_hello(sample), None);
        }
    }

    #[test]
    fn garbage_is_not_a_hello() {
        assert_eq!(inspect_client_hello(&[]), HelloProgress::NeedMore);
        assert_eq!(parse_client_hello(&[]), None);

        // A TLS record, but not a ClientHello: a ServerHello, application data, an alert
        let server_hello = [0x16, 3, 3, 0, 4, 0x02, 0, 0, 0];
        let app_data = [0x17, 3, 3, 0, 4, 1, 2, 3, 4];
        let alert = [0x15, 3, 3, 0, 2, 2, 40];
        for bytes in [&server_hello[..], &app_data[..], &alert[..]] {
            assert_eq!(inspect_client_hello(bytes), HelloProgress::NotTls, "{bytes:?}");
        }

        // Record versions and lengths that no TLS stack sends
        assert_eq!(inspect_client_hello(&[0x16, 4, 1, 0, 9]), HelloProgress::NotTls);
        assert_eq!(inspect_client_hello(&[0x16, 3, 9, 0, 9]), HelloProgress::NotTls);
        assert_eq!(inspect_client_hello(&[0x16, 3, 1, 0, 0]), HelloProgress::NotTls);
        assert_eq!(inspect_client_hello(&[0x16, 3, 1, 0xff, 0xff]), HelloProgress::NotTls);
        // A handshake message that claims to be bigger than any ClientHello
        assert_eq!(inspect_client_hello(&[0x16, 3, 1, 0, 9, 1, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0]), HelloProgress::NotTls);
    }

    #[test]
    fn a_hello_whose_inner_lengths_lie_is_not_a_hello() {
        let good = chrome_like("example.com", &CHROME_ECH_ALPS).handshake_message();

        // Every byte of the body set to 0xff, one at a time, or cut off inside the message
        // while the lengths around it stay right
        for index in HANDSHAKE_HEADER_LEN..good.len() {
            let mut bent = good.clone();
            bent[index] = 0xff;
            let _ = inspect_client_hello(&wrap_in_records(&bent, usize::MAX)); // must not panic
        }
        let mut cut = good.clone();
        cut.truncate(good.len() - 10);
        cut[3] = (cut.len() - HANDSHAKE_HEADER_LEN) as u8;
        cut[2] = ((cut.len() - HANDSHAKE_HEADER_LEN) >> 8) as u8;
        assert_eq!(inspect_client_hello(&wrap_in_records(&cut, usize::MAX)), HelloProgress::NotTls);

        // No cipher suites at all
        let mut spec = chrome_like("example.com", &CHROME_ECH_ALPS);
        spec.cipher_suites.clear();
        assert_eq!(inspect_client_hello(&spec.record()), HelloProgress::NotTls);
    }

    #[test]
    fn arbitrary_bytes_never_panic() {
        // A tiny xorshift generator keeps the test repeatable without another crate
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let valid = chrome_like("example.com", &CHROME_ECH_ALPS).record();

        for round in 0..4000 {
            let len = (next() % 700) as usize;
            let mut bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            // Make half of them look like the start of a hello, so the parser gets deeper
            if round % 2 == 0 && bytes.len() > 10 {
                let (len_high, len_low) = (bytes[3], bytes[4]);
                bytes[..6].copy_from_slice(&[0x16, 3, 1, len_high, len_low, 1]);
            }
            let _ = inspect_client_hello(&bytes);

            // And a valid hello with a few bytes changed
            let mut bent = valid.clone();
            for _ in 0..3 {
                let at = (next() % bent.len() as u64) as usize;
                bent[at] = next() as u8;
            }
            let _ = inspect_client_hello(&bent);
        }
    }

    // ---- hellos captured from real clients -------------------------------------------------
    //
    // The files in tests/fixtures/ja4 hold the first bytes real clients sent to a local
    // listener (see the README there). The expected JA4s come from ja4_reference.py, a separate
    // implementation of the spec in Python, not from this code.

    fn fixture(hex: &str) -> Vec<u8> {
        let digits: Vec<u8> = hex.bytes().filter(|b| b.is_ascii_hexdigit()).collect();
        digits
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    struct RealHello {
        client: &'static str,
        hex: &'static str,
        sni: &'static str,
        alpn: &'static [&'static str],
        ja4: &'static str,
    }

    const CHROME_JA4: &str = "t13d1517h2_8daaf6152771_cb7bf5808d99";

    const REAL_HELLOS: [RealHello; 7] = [
        RealHello {
            client: "Chrome 154",
            hex: include_str!("../../tests/fixtures/ja4/chrome-154.hex"),
            sni: "example.com",
            alpn: &["h2", "http/1.1"],
            ja4: CHROME_JA4,
        },
        RealHello {
            client: "Chrome 154, second connection",
            hex: include_str!("../../tests/fixtures/ja4/chrome-154-second-connection.hex"),
            sni: "example.com",
            alpn: &["h2", "http/1.1"],
            ja4: CHROME_JA4,
        },
        RealHello {
            client: "OpenSSL 3.6.5 s_client",
            hex: include_str!("../../tests/fixtures/ja4/openssl-3.6.5.hex"),
            sni: "example.com",
            alpn: &["h2", "http/1.1"],
            ja4: "t13d3012h2_1d37bd780c83_8e6e362c5eac",
        },
        RealHello {
            client: "LibreSSL 3.3.6 s_client",
            hex: include_str!("../../tests/fixtures/ja4/libressl-3.3.6.hex"),
            sni: "www.example.org",
            alpn: &[],
            ja4: "t13d490700_0d8feac7bc37_460f73f9cefb",
        },
        RealHello {
            client: "curl 8.7.1",
            hex: include_str!("../../tests/fixtures/ja4/curl-8.7.1.hex"),
            sni: "example.com",
            alpn: &["h2", "http/1.1"],
            ja4: "t13d4907h2_0d8feac7bc37_7395dae3b2f3",
        },
        RealHello {
            client: "Python 3.14 ssl",
            hex: include_str!("../../tests/fixtures/ja4/python-3.14-ssl.hex"),
            sni: "api.example.net",
            alpn: &[],
            ja4: "t13d181100_85036bcba153_d41ae481755e",
        },
        RealHello {
            client: "Node 24 tls",
            hex: include_str!("../../tests/fixtures/ja4/node-24-tls.hex"),
            sni: "cdn.example.com",
            alpn: &["h2", "http/1.1"],
            ja4: "t13d5212h2_b262b3658495_8e6e362c5eac",
        },
    ];

    #[test]
    fn real_hellos_from_local_clients() {
        for case in &REAL_HELLOS {
            let hello = parse_client_hello(&fixture(case.hex)).unwrap_or_else(|| panic!("{} parses", case.client));
            assert_eq!(hello.sni.as_deref(), Some(case.sni), "{} sni", case.client);
            assert_eq!(hello.alpn, case.alpn, "{} alpn", case.client);
            assert_eq!(hello.ja4, case.ja4, "{} ja4", case.client);
        }
    }

    #[test]
    fn real_hellos_arriving_in_pieces_wait_for_the_rest() {
        for case in &REAL_HELLOS {
            let bytes = fixture(case.hex);
            // The tunnel's packets are about 1400 bytes, so a big hello comes in two reads
            let cut = bytes.len().min(1300);
            if cut < bytes.len() {
                assert_eq!(inspect_client_hello(&bytes[..cut]), HelloProgress::NeedMore, "{}", case.client);
            }
            assert_eq!(parse_client_hello(&bytes).map(|h| h.ja4).as_deref(), Some(case.ja4), "{}", case.client);

            // The same hello cut into small TLS records still reads the same
            let message = &bytes[RECORD_HEADER_LEN..];
            let records = wrap_in_records(message, 333);
            assert_eq!(parse_client_hello(&records).map(|h| h.ja4).as_deref(), Some(case.ja4), "{} in records", case.client);
        }
    }

    #[test]
    fn the_real_chromes_fingerprint_has_the_published_cipher_hash() {
        // 8daaf6152771 is the cipher hash every Chrome shares, as in the spec's examples
        assert!(CHROME_JA4.contains("_8daaf6152771_"));
        let hello = parse_client_hello(&fixture(REAL_HELLOS[0].hex)).unwrap();
        assert!(hello.ja4.starts_with("t13d15"), "{}", hello.ja4);
    }
}
