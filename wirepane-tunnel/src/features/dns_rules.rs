//! DNS spoofing and blocking (T4): rules the DNS responder checks before it resolves a name.
//!
//! A rule is an exact name (`api.example.com`) or a wildcard for everything below a name
//! (`*.example.com`, which does not match `example.com` itself). Names compare without regard to
//! case and one trailing dot is ignored, so `API.Example.com.` is `api.example.com`. The first
//! rule that matches wins, so a specific rule goes before the wildcard that would also catch it.

use std::net::Ipv4Addr;

/// The DNS limits for a whole name and for one label (the part between dots).
const MAX_NAME_LEN: usize = 253;
const MAX_LABEL_LEN: usize = 63;

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

/// A pattern after checking, kept lower case so a lookup never has to build a new string.
#[derive(Debug, Clone)]
enum Matcher {
    /// The whole name.
    Exact(String),
    /// Anything below a name. Holds the name with a leading dot (`.example.com`), so
    /// `badexample.com` can't match and the bare `example.com` is too short to.
    Below(String),
}

impl Matcher {
    /// `name` has no trailing dot and no empty label.
    fn matches(&self, name: &str) -> bool {
        match self {
            Matcher::Exact(exact) => name.eq_ignore_ascii_case(exact),
            Matcher::Below(suffix) => {
                // Compared as bytes, so a name with multi-byte characters can't panic on a slice
                let (name, suffix) = (name.as_bytes(), suffix.as_bytes());
                name.len() > suffix.len()
                    && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
            }
        }
    }
}

#[derive(Debug, Clone)]
struct CheckedRule {
    matcher: Matcher,
    action: DnsAction,
}

#[derive(Debug, Clone, Default)]
pub struct DnsRules {
    rules: Vec<CheckedRule>,
}

impl DnsRules {
    /// Fails on a pattern that can't match anything, and says which rule and why. Nothing is
    /// kept then, so a bad list never replaces a working one.
    pub fn new(rules: Vec<DnsRule>) -> Result<Self, String> {
        let mut checked = Vec::with_capacity(rules.len());
        for (index, rule) in rules.into_iter().enumerate() {
            let matcher = parse_pattern(&rule.pattern).map_err(|reason| {
                format!("DNS rule {} ({}): {reason}", index + 1, shown(&rule.pattern))
            })?;
            checked.push(CheckedRule { matcher, action: rule.action });
        }
        Ok(DnsRules { rules: checked })
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// The action for a queried name, from the first rule that matches.
    pub fn decide(&self, name: &str) -> Option<&DnsAction> {
        let name = name.strip_suffix('.').unwrap_or(name);
        // The DNS core never passes a name with an empty label, and no rule should catch one
        if name.split('.').any(str::is_empty) {
            return None;
        }
        self.rules.iter().find(|rule| rule.matcher.matches(name)).map(|rule| &rule.action)
    }
}

/// The pattern as it goes into an error message: escaped, and cut short if someone pasted a lot.
fn shown(pattern: &str) -> String {
    const SHOWN_CHARS: usize = 40;
    let start: String = pattern.chars().take(SHOWN_CHARS).collect();
    let more = if pattern.chars().count() > SHOWN_CHARS { "..." } else { "" };
    format!("{start:?}{more}")
}

fn parse_pattern(raw: &str) -> Result<Matcher, String> {
    // A space around a pasted name is never meant, so it's trimmed instead of rejected
    let pattern = raw.trim();
    let pattern = pattern.strip_suffix('.').unwrap_or(pattern);

    if pattern.is_empty() {
        return Err("the pattern is empty".into());
    }
    if pattern == "*" {
        return Err("a lone * would match every name; write *.example.com for the subdomains of a name".into());
    }
    if !pattern.is_ascii() {
        return Err("only ASCII letters, digits, - and _ are allowed; write an international name in its xn-- form".into());
    }
    if pattern.len() > MAX_NAME_LEN {
        return Err(format!("a name has at most {MAX_NAME_LEN} characters"));
    }

    let (below, name) = match pattern.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, pattern),
    };
    if name.contains('*') {
        return Err("the * can only be the whole first part, as in *.example.com".into());
    }
    for label in name.split('.') {
        check_label(label)?;
    }

    let name = name.to_ascii_lowercase();
    Ok(if below { Matcher::Below(format!(".{name}")) } else { Matcher::Exact(name) })
}

fn check_label(label: &str) -> Result<(), String> {
    if label.is_empty() {
        return Err("it has an empty part (a dot at the start, or two dots in a row)".into());
    }
    if label.len() > MAX_LABEL_LEN {
        return Err(format!("each part between dots has at most {MAX_LABEL_LEN} characters"));
    }
    // The same characters the DNS core accepts in a question, so a rule can match what arrives
    if let Some(bad) = label.chars().find(|c| !(c.is_ascii_alphanumeric() || *c == '-' || *c == '_')) {
        return Err(format!("{bad:?} is not allowed in a name (letters, digits, - and _ only)"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(pattern: &str) -> DnsRule {
        DnsRule { pattern: pattern.into(), action: DnsAction::Block }
    }

    fn answer(pattern: &str, ip: [u8; 4]) -> DnsRule {
        DnsRule { pattern: pattern.into(), action: DnsAction::Answer(Ipv4Addr::from(ip)) }
    }

    fn rules(list: Vec<DnsRule>) -> DnsRules {
        DnsRules::new(list).expect("these rules are valid")
    }

    fn error_of(pattern: &str) -> String {
        DnsRules::new(vec![block(pattern)]).expect_err("this pattern should be rejected")
    }

    #[test]
    fn exact_name_matches_only_itself() {
        let rules = rules(vec![block("api.example.com")]);

        assert_eq!(rules.decide("api.example.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("example.com"), None);
        assert_eq!(rules.decide("www.api.example.com"), None);
        assert_eq!(rules.decide("api.example.org"), None);
        assert_eq!(rules.decide("xapi.example.com"), None);
    }

    #[test]
    fn wildcard_matches_subdomains_but_not_the_bare_suffix() {
        let rules = rules(vec![block("*.example.com")]);

        assert_eq!(rules.decide("api.example.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("a.b.example.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("example.com"), None);
        assert_eq!(rules.decide("badexample.com"), None);
        assert_eq!(rules.decide("api.example.com.evil.org"), None);
        assert_eq!(rules.decide("api.example.org"), None);
    }

    #[test]
    fn names_compare_without_regard_to_case() {
        let rules = rules(vec![block("API.Example.COM"), answer("*.Test.Local", [10, 0, 0, 1])]);

        assert_eq!(rules.decide("api.example.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("Api.EXAMPLE.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("WWW.TEST.LOCAL"), Some(&DnsAction::Answer(Ipv4Addr::new(10, 0, 0, 1))));
    }

    #[test]
    fn one_trailing_dot_is_ignored_in_patterns_and_in_names() {
        let rules = rules(vec![block("example.com."), block("*.example.org.")]);

        assert_eq!(rules.decide("example.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("example.com."), Some(&DnsAction::Block));
        assert_eq!(rules.decide("www.example.org."), Some(&DnsAction::Block));
        assert_eq!(rules.decide("example.org."), None);
    }

    #[test]
    fn surrounding_spaces_in_a_pattern_are_trimmed() {
        let rules = rules(vec![block("  example.com\t")]);
        assert_eq!(rules.decide("example.com"), Some(&DnsAction::Block));
    }

    #[test]
    fn the_first_matching_rule_wins() {
        let ip = Ipv4Addr::new(192, 168, 0, 10);
        let specific_first = rules(vec![answer("api.example.com", [192, 168, 0, 10]), block("*.example.com")]);
        assert_eq!(specific_first.decide("api.example.com"), Some(&DnsAction::Answer(ip)));
        assert_eq!(specific_first.decide("www.example.com"), Some(&DnsAction::Block));

        let wildcard_first = rules(vec![block("*.example.com"), answer("api.example.com", [192, 168, 0, 10])]);
        assert_eq!(wildcard_first.decide("api.example.com"), Some(&DnsAction::Block));
    }

    #[test]
    fn answer_rules_give_back_their_address() {
        let rules = rules(vec![answer("api.test", [192, 168, 0, 10])]);
        assert_eq!(rules.decide("api.test"), Some(&DnsAction::Answer(Ipv4Addr::new(192, 168, 0, 10))));
    }

    #[test]
    fn no_rules_means_no_decision() {
        let none = rules(vec![]);
        assert!(none.is_empty());
        assert_eq!(none.len(), 0);
        assert_eq!(none.decide("example.com"), None);
        assert!(DnsRules::default().is_empty());

        let some = rules(vec![block("a.test"), block("b.test")]);
        assert!(!some.is_empty());
        assert_eq!(some.len(), 2);
    }

    #[test]
    fn a_single_label_name_and_a_top_level_wildcard_are_valid() {
        let rules = rules(vec![block("localhost"), block("*.zz")]);
        assert_eq!(rules.decide("localhost"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("a.zz"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("zz"), None);
    }

    #[test]
    fn underscores_digits_and_hyphens_are_valid_in_names() {
        let rules = rules(vec![block("_acme-challenge.example.com"), block("*.cdn-1.example.com")]);
        assert_eq!(rules.decide("_acme-challenge.example.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("a.cdn-1.example.com"), Some(&DnsAction::Block));
    }

    #[test]
    fn names_the_dns_core_would_never_pass_match_nothing() {
        let rules = rules(vec![block("*.example.com"), block("example.com")]);

        assert_eq!(rules.decide(""), None);
        assert_eq!(rules.decide("."), None);
        assert_eq!(rules.decide(".example.com"), None);
        assert_eq!(rules.decide("a..example.com"), None);
        assert_eq!(rules.decide("example.com.."), None);
    }

    #[test]
    fn a_name_with_multi_byte_characters_does_not_panic() {
        let rules = rules(vec![block("*.example.com"), block("example.org")]);

        // The cut for the suffix falls inside a character in some of these
        assert_eq!(rules.decide("\u{e9}.com"), None);
        assert_eq!(rules.decide("a\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}.com"), None);
        assert_eq!(rules.decide("\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}.example.com"), Some(&DnsAction::Block));
        assert_eq!(rules.decide("\u{1f600}example.org"), None);
    }

    #[test]
    fn decide_agrees_with_a_plain_reference_on_every_odd_name() {
        let rules = rules(vec![block("a.b"), block("*.x.y")]);
        // Every name of up to five characters from these, with dots, a wildcard and multi-byte ones
        let alphabet = ["a", "B", ".", "*", "x", "y", "\u{e9}", "\u{1f600}", "-"];
        let mut names = vec![String::new()];
        let mut level = vec![String::new()];
        for _ in 0..5 {
            level = level
                .iter()
                .flat_map(|prefix| alphabet.iter().map(move |c| format!("{prefix}{c}")))
                .collect();
            names.extend(level.iter().cloned());
        }

        for name in names {
            let lower = name.to_ascii_lowercase();
            let trimmed = lower.strip_suffix('.').unwrap_or(&lower);
            let labels: Vec<&str> = trimmed.split('.').collect();
            let well_formed = labels.iter().all(|label| !label.is_empty());
            let expected = well_formed
                && (trimmed == "a.b" || (labels.len() >= 3 && trimmed.ends_with(".x.y")));
            assert_eq!(rules.decide(&name).is_some(), expected, "name {name:?}");
        }
    }

    #[test]
    fn invalid_patterns_are_rejected_with_a_clear_message() {
        assert!(error_of("").contains("empty"));
        assert!(error_of("   ").contains("empty"));
        assert!(error_of(".").contains("empty"));
        assert!(error_of("*").contains("every name"));
        assert!(error_of("*.").contains("every name"));
        assert!(error_of(".example.com").contains("empty part"));
        assert!(error_of("a..example.com").contains("empty part"));
        assert!(error_of("example.com..").contains("empty part"));
        assert!(error_of("exa mple.com").contains("' ' is not allowed"));
        assert!(error_of("exam/ple.com").contains("'/' is not allowed"));
        assert!(error_of("http://example.com").contains("is not allowed"));
        assert!(error_of("example.com:8080").contains("':' is not allowed"));
        assert!(error_of("a*.example.com").contains("whole first part"));
        assert!(error_of("api.*.example.com").contains("whole first part"));
        assert!(error_of("*.*.example.com").contains("whole first part"));
        assert!(error_of("**.example.com").contains("whole first part"));
        assert!(error_of("m\u{fc}nchen.de").contains("xn--"));
    }

    #[test]
    fn names_and_parts_over_the_dns_limits_are_rejected() {
        let longest_label = "a".repeat(MAX_LABEL_LEN);
        assert!(DnsRules::new(vec![block(&format!("{longest_label}.com"))]).is_ok());
        let too_long_label = "a".repeat(MAX_LABEL_LEN + 1);
        assert!(error_of(&format!("{too_long_label}.com")).contains("at most 63"));

        // 4 labels of 62 characters and 3 dots = 251, plus ".c" = 253
        let label = "b".repeat(62);
        let longest_name = format!("{label}.{label}.{label}.{label}.c");
        assert_eq!(longest_name.len(), MAX_NAME_LEN);
        assert!(DnsRules::new(vec![block(&longest_name)]).is_ok());
        assert!(error_of(&format!("{longest_name}x")).contains("at most 253"));
    }

    #[test]
    fn the_error_names_the_rule_and_the_pattern() {
        let err = DnsRules::new(vec![block("ok.example.com"), block("bad pattern.com")]).unwrap_err();
        assert!(err.starts_with("DNS rule 2 (\"bad pattern.com\")"), "{err}");

        // A pasted novel doesn't end up in full in the message
        let err = error_of(&format!("{} x", "a".repeat(500)));
        assert!(err.len() < 200, "{err}");
        assert!(err.contains("..."), "{err}");
    }

    #[test]
    fn one_bad_rule_rejects_the_whole_list() {
        assert!(DnsRules::new(vec![block("good.test"), block("bad pattern"), block("also-good.test")]).is_err());
    }

    #[test]
    fn duplicates_are_allowed_and_the_first_one_decides() {
        let ip = Ipv4Addr::new(10, 1, 1, 1);
        let rules = rules(vec![answer("dup.test", [10, 1, 1, 1]), block("dup.test")]);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules.decide("dup.test"), Some(&DnsAction::Answer(ip)));
    }
}
