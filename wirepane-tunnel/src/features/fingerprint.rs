//! JA4 fingerprints (T5): what a TLS ClientHello says about the app that sent it.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsHello {
    pub sni: Option<String>,
    pub alpn: Vec<String>,
    /// The JA4 string, e.g. `t13d1516h2_8daaf6152771_02713d6af862`.
    pub ja4: String,
}

/// Parses the first bytes a client sent on a TCP flow. None when they aren't a complete TLS
/// ClientHello (another protocol, or not all of it arrived yet). Stub: always None.
pub fn parse_client_hello(_first_bytes: &[u8]) -> Option<TlsHello> {
    None
}
