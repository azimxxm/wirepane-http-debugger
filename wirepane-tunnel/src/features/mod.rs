//! The network tools that work on VPN-mode traffic (docs/plans/2026-10-13-rust-network-tools.md).
//!
//! The lead wrote these modules as stubs with the agreed signatures. Each tool owns its file and
//! fills it in; T0 calls them from the core's hooks. Until a tool is done its stub is neutral:
//! traffic passes untouched.

pub mod capture;
pub mod conditions;
pub mod dns_rules;
pub mod fingerprint;
pub mod quic;

/// Which way an IP packet travels through the tunnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    FromPhone,
    ToPhone,
}
