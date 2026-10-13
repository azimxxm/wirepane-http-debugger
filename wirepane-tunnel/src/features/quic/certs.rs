//! Leaf certificates from the Wirepane CA, one per server name, for the phone's side of HTTP/3, and
//! the TLS settings for both sides: the QUIC server the phone talks to, and the TLS client that
//! talks to Mockttp (which presents its own Wirepane CA certificate for the same host).

use std::collections::HashMap;
use std::fmt;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};

use anyhow::{Context, Result, anyhow};
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType, SerialNumber,
};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::{CertifiedKey, SigningKey};
use time::{Duration, OffsetDateTime};

use crate::frontend::wireguard::lock;

/// Minted certificates kept in memory; the cache starts over when it is full.
const MAX_CACHED_CERTS: usize = 1024;
/// Under Apple's 825-day limit for certificates from a user-trusted CA, with a day of clock slack.
const LEAF_DAYS: i64 = 365;

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Signs leaf certificates with the Wirepane CA. Every leaf shares one ECDSA P-256 key (like
/// Mockttp's leaves share one key), so minting a new host costs one CA signature.
pub struct LeafIssuer {
    issuer: Issuer<'static, KeyPair>,
    leaf_key: KeyPair,
    signing_key: Arc<dyn SigningKey>,
    ca_der: CertificateDer<'static>,
    cache: Mutex<HashMap<String, Arc<CertifiedKey>>>,
}

impl fmt::Debug for LeafIssuer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LeafIssuer")
    }
}

impl LeafIssuer {
    pub fn new(ca_cert_pem: &str, ca_key_pem: &str) -> Result<Self> {
        let ca_key = KeyPair::from_pem(ca_key_pem)
            .map_err(|error| anyhow!("the CA key is not a PKCS#8 PEM key ({error})"))?;
        let issuer = Issuer::from_ca_cert_pem(ca_cert_pem, ca_key)
            .map_err(|error| anyhow!("the CA certificate can't be read ({error})"))?;
        let ca_der = CertificateDer::from_pem_slice(ca_cert_pem.as_bytes())
            .map_err(|error| anyhow!("the CA certificate is not PEM ({error})"))?;
        let leaf_key = KeyPair::generate().map_err(|error| anyhow!("no leaf key: {error}"))?;
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
        let signing_key = provider()
            .key_provider
            .load_private_key(key_der)
            .context("the leaf key can't be used for TLS")?;
        Ok(Self {
            issuer,
            leaf_key,
            signing_key,
            ca_der,
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn ca_der(&self) -> CertificateDer<'static> {
        self.ca_der.clone()
    }

    /// The certificate for a server name (a DNS name or an IP address), minted on first use.
    pub fn leaf_for(&self, name: &str) -> Result<Arc<CertifiedKey>> {
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        if let Some(found) = lock(&self.cache).get(&name) {
            return Ok(found.clone());
        }
        let minted = Arc::new(self.mint(&name)?);
        let mut cache = lock(&self.cache);
        if cache.len() >= MAX_CACHED_CERTS {
            cache.clear();
        }
        cache.insert(name, minted.clone());
        Ok(minted)
    }

    fn mint(&self, name: &str) -> Result<CertifiedKey> {
        let mut params = CertificateParams::default();
        params.subject_alt_names = vec![match name.parse::<IpAddr>() {
            Ok(ip) => SanType::IpAddress(ip),
            Err(_) => {
                // Same rules rustls applies to SNI, so a name from anywhere else is held to them too.
                rustls::pki_types::DnsName::try_from(name)
                    .map_err(|_| anyhow!("{name:?} is not a host name"))?;
                SanType::DnsName(
                    name.to_string()
                        .try_into()
                        .map_err(|error| anyhow!("{name:?} is not a host name ({error})"))?,
                )
            }
        }];
        let mut subject = DistinguishedName::new();
        subject.push(DnType::CommonName, name);
        params.distinguished_name = subject;
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        // Points at the CA's own key id, so path building finds the issuer at once.
        params.use_authority_key_identifier_extension = true;
        // rcgen's default serial is a hash of the key, the same for every leaf here; browsers
        // reject two different certificates with the same issuer and serial.
        params.serial_number = Some(random_serial()?);
        let now = OffsetDateTime::now_utc();
        params.not_before = now - Duration::days(1);
        params.not_after = now + Duration::days(LEAF_DAYS);

        let cert = params
            .signed_by(&self.leaf_key, &self.issuer)
            .map_err(|error| anyhow!("can't sign a certificate for {name}: {error}"))?;
        Ok(CertifiedKey::new(vec![cert.der().clone()], self.signing_key.clone()))
    }
}

fn random_serial() -> Result<SerialNumber> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| anyhow!("no randomness: {error}"))?;
    bytes[0] &= 0x7f; // positive
    bytes[0] |= 0x01; // and never shorter than 16 bytes
    Ok(SerialNumber::from_slice(&bytes))
}

/// How long a host stays known as passed through (see `PassthroughHosts`).
const PASSTHROUGH_TTL: StdDuration = StdDuration::from_secs(600);
const MAX_PASSTHROUGH_HOSTS: usize = 1024;

/// Hosts that Mockttp passes through untouched (its TLS passthrough rules, e.g. Apple's pinned
/// services). For them Mockttp's side of the TLS hop is the real server's certificate, which the
/// gateway can't check against the Wirepane CA, so the request can't be replayed. Once a host is
/// known, its QUIC handshakes are refused, and the phone falls back to TCP, which Mockttp passes
/// through as it should.
#[derive(Debug, Default)]
pub struct PassthroughHosts {
    hosts: Mutex<HashMap<String, Instant>>,
}

impl PassthroughHosts {
    pub fn insert(&self, name: &str) {
        let mut hosts = lock(&self.hosts);
        if hosts.len() >= MAX_PASSTHROUGH_HOSTS {
            hosts.clear();
        }
        hosts.insert(name.trim_end_matches('.').to_ascii_lowercase(), Instant::now() + PASSTHROUGH_TTL);
    }

    pub fn contains(&self, name: &str) -> bool {
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        let mut hosts = lock(&self.hosts);
        match hosts.get(&name) {
            Some(until) if *until > Instant::now() => true,
            Some(_) => {
                hosts.remove(&name);
                false
            }
            None => false,
        }
    }
}

/// Picks the leaf for the name in the phone's ClientHello. Without SNI (a URL with an IP address)
/// the certificate is for the address the phone dialled. A passed-through host gets none, which
/// fails the handshake.
#[derive(Debug)]
pub struct LeafResolver {
    pub issuer: Arc<LeafIssuer>,
    pub fallback: Option<IpAddr>,
    pub passthrough: Option<Arc<PassthroughHosts>>,
}

impl ResolvesServerCert for LeafResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let name = match (hello.server_name(), self.fallback) {
            (Some(name), _) => name.to_string(),
            (None, Some(ip)) => ip.to_string(),
            (None, None) => return None,
        };
        if self.passthrough.as_ref().is_some_and(|hosts| hosts.contains(&name)) {
            log::debug!("HTTP/3: {name} is passed through by the proxy, refusing QUIC so the phone uses TCP");
            return None;
        }
        match self.issuer.leaf_for(&name) {
            Ok(key) => Some(key),
            Err(error) => {
                log::warn!("HTTP/3: no certificate for {name}: {error:#}");
                None
            }
        }
    }
}

pub const ALPN_H3: &[u8] = b"h3";

/// The QUIC server side for one incoming connection: TLS 1.3 (QUIC needs it), ALPN h3, no 0-RTT
/// (replayable early data would reach Mockttp twice).
pub fn quic_server_config(
    issuer: Arc<LeafIssuer>,
    fallback: Option<IpAddr>,
    passthrough: Arc<PassthroughHosts>,
    transport: Arc<quinn::TransportConfig>,
) -> Result<quinn::ServerConfig> {
    let resolver = LeafResolver { issuer, fallback, passthrough: Some(passthrough) };
    let mut tls = rustls::ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(resolver));
    tls.alpn_protocols = vec![ALPN_H3.to_vec()];
    tls.max_early_data_size = 0;
    let quic = quinn::crypto::rustls::QuicServerConfig::try_from(tls)
        .map_err(|error| anyhow!("TLS settings unusable for QUIC: {error}"))?;
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(quic));
    config.transport_config(transport);
    Ok(config)
}

/// The TLS client for the hop to Mockttp. It trusts only the Wirepane CA: Mockttp answers with a
/// certificate from that CA for the host, and nothing else may answer in its place. HTTP/1.1 only.
pub fn proxy_tls(ca_der: CertificateDer<'static>) -> Result<tokio_rustls::TlsConnector> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca_der).context("the CA certificate can't be a trust anchor")?;
    let mut config = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
}
