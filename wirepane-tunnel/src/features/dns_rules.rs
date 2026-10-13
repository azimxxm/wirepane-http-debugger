//! DNS spoofing and blocking (T4): rules the DNS responder checks before it resolves a name.

use std::net::Ipv4Addr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsAction {
    /// Answer as if the name doesn't exist.
    Block,
    /// Answer with this address instead of the real one.
    Answer(Ipv4Addr),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsRule {
    /// A name like `api.example.com`, or a wildcard like `*.example.com`.
    pub pattern: String,
    pub action: DnsAction,
}

#[derive(Debug, Clone, Default)]
pub struct DnsRules {
    rules: Vec<DnsRule>,
}

impl DnsRules {
    /// Fails on a pattern that can't match anything. Stub: takes the list as given.
    pub fn new(rules: Vec<DnsRule>) -> Result<Self, String> {
        Ok(DnsRules { rules })
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// The action for a queried name, if a rule matches. Stub: never matches.
    pub fn decide(&self, _name: &str) -> Option<&DnsAction> {
        None
    }
}
