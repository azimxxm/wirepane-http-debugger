//! JSON-lines events for the parent process (stdout). Logs never go here, they go to stderr.

use std::io::Write;
use std::sync::Arc;

use serde_json::{Value, json};

#[derive(Clone)]
pub struct EventSink(Arc<dyn Fn(Value) + Send + Sync>);

impl EventSink {
    /// One compact JSON object per line, flushed right away so the parent sees it at once.
    pub fn stdout() -> Self {
        Self(Arc::new(|value| {
            let line = value.to_string();
            let mut out = std::io::stdout().lock();
            // A closed stdout means the parent is gone; stdin EOF ends the process soon after.
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }))
    }

    pub fn from_fn(handler: impl Fn(Value) + Send + Sync + 'static) -> Self {
        Self(Arc::new(handler))
    }

    pub fn emit(&self, value: Value) {
        (self.0)(value);
    }

    pub fn error(&self, message: impl Into<String>) {
        self.emit(json!({ "event": "error", "message": message.into() }));
    }
}
