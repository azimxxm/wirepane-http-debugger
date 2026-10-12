//! The virtual network the phones live in (default 10.73.0.0/24).
//!
//! Layout inside the net: .1 is the "server", .53 is the DNS server, .54 is the virtual address
//! `wirepane.cert` resolves to, and peers get the lowest free address from .2 upwards.

use std::collections::HashSet;
use std::net::Ipv4Addr;

use anyhow::{Result, anyhow, bail};

const SERVER_OFFSET: u32 = 1;
const DNS_OFFSET: u32 = 53;
const CERT_OFFSET: u32 = 54;
const FIRST_PEER_OFFSET: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TunnelNet {
    base: u32,
    prefix: u8,
}

impl TunnelNet {
    /// Parses "10.73.0.0/24". The prefix has to be between /16 and /24 so the fixed offsets fit.
    pub fn parse(text: &str) -> Result<Self> {
        let (ip_text, prefix_text) = text
            .split_once('/')
            .ok_or_else(|| anyhow!("tunnel net must look like 10.73.0.0/24, got {text:?}"))?;
        let ip: Ipv4Addr = ip_text
            .parse()
            .map_err(|_| anyhow!("bad tunnel net address {ip_text:?}"))?;
        let prefix: u8 = prefix_text
            .parse()
            .map_err(|_| anyhow!("bad tunnel net prefix {prefix_text:?}"))?;
        if !(16..=24).contains(&prefix) {
            bail!("tunnel net prefix must be between /16 and /24, got /{prefix}");
        }
        let mask = u32::MAX << (32 - prefix);
        Ok(Self {
            base: u32::from(ip) & mask,
            prefix,
        })
    }

    fn at(&self, offset: u32) -> Ipv4Addr {
        Ipv4Addr::from(self.base + offset)
    }

    fn size(&self) -> u32 {
        1u32 << (32 - self.prefix)
    }

    pub fn server_ip(&self) -> Ipv4Addr {
        self.at(SERVER_OFFSET)
    }

    pub fn dns_ip(&self) -> Ipv4Addr {
        self.at(DNS_OFFSET)
    }

    pub fn cert_ip(&self) -> Ipv4Addr {
        self.at(CERT_OFFSET)
    }

    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        let mask = u32::MAX << (32 - self.prefix);
        u32::from(ip) & mask == self.base
    }

    /// Lowest free peer address, skipping the reserved ones and the broadcast address.
    pub fn allocate(&self, used: &HashSet<Ipv4Addr>) -> Result<Ipv4Addr> {
        let last = self.size() - 2;
        for offset in FIRST_PEER_OFFSET..=last {
            if offset == DNS_OFFSET || offset == CERT_OFFSET {
                continue;
            }
            let ip = self.at(offset);
            if !used.contains(&ip) {
                return Ok(ip);
            }
        }
        bail!("no free tunnel address left in the net")
    }
}

impl std::fmt::Display for TunnelNet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", Ipv4Addr::from(self.base), self.prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_net_layout() {
        let net = TunnelNet::parse("10.73.0.0/24").unwrap();
        assert_eq!(net.server_ip(), Ipv4Addr::new(10, 73, 0, 1));
        assert_eq!(net.dns_ip(), Ipv4Addr::new(10, 73, 0, 53));
        assert_eq!(net.cert_ip(), Ipv4Addr::new(10, 73, 0, 54));
        let mut used = HashSet::new();
        assert_eq!(net.allocate(&used).unwrap(), Ipv4Addr::new(10, 73, 0, 2));
        used.insert(Ipv4Addr::new(10, 73, 0, 2));
        assert_eq!(net.allocate(&used).unwrap(), Ipv4Addr::new(10, 73, 0, 3));
    }

    #[test]
    fn allocation_skips_reserved_addresses() {
        let net = TunnelNet::parse("10.73.0.0/24").unwrap();
        let used: HashSet<Ipv4Addr> = (2..53).map(|n| Ipv4Addr::new(10, 73, 0, n)).collect();
        assert_eq!(net.allocate(&used).unwrap(), Ipv4Addr::new(10, 73, 0, 55));
    }

    #[test]
    fn rejects_bad_nets() {
        assert!(TunnelNet::parse("10.73.0.0").is_err());
        assert!(TunnelNet::parse("10.73.0.0/30").is_err());
        assert!(TunnelNet::parse("nope/24").is_err());
    }
}
