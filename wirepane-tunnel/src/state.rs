//! The state file: the server key and the peers, so a scanned QR code stays valid across
//! restarts. It holds private keys, so it is created with mode 0600.

use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPeer {
    pub peer: String,
    pub name: String,
    pub kind: String,
    pub tunnel_ip: String,
    /// The phone's private key (base64). Kept so the config can be shown again later.
    pub private_key: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateFile {
    pub version: u32,
    pub server_private_key: String,
    /// Peer ids are never reused, so a stale tag can't point at a different phone.
    pub next_peer: u32,
    pub peers: Vec<StoredPeer>,
}

impl StateFile {
    pub fn fresh(server_private_key: String) -> Self {
        Self {
            version: STATE_VERSION,
            server_private_key,
            next_peer: 1,
            peers: Vec::new(),
        }
    }

    /// Reads the state, or None when the file doesn't exist yet. A file that can't be parsed is
    /// moved aside (never deleted) and treated as missing, so a damaged file can't block the VPN.
    pub fn load(path: &Path) -> Result<Option<Self>> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("cannot read {}", path.display()));
            }
        };
        match serde_json::from_str::<StateFile>(&text) {
            Ok(state) if state.version == STATE_VERSION => Ok(Some(state)),
            _ => {
                let mut aside = path.as_os_str().to_owned();
                aside.push(".unreadable");
                log::warn!(
                    "state file {} is unreadable, moving it to {:?} and starting fresh",
                    path.display(),
                    aside
                );
                fs::rename(path, &aside)
                    .with_context(|| format!("cannot move {} aside", path.display()))?;
                Ok(None)
            }
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)
                .with_context(|| format!("cannot create {}", parent.display()))?;
        }
        let mut temp = path.as_os_str().to_owned();
        temp.push(".tmp");
        let temp = std::path::PathBuf::from(temp);
        let json = serde_json::to_vec_pretty(self).context("cannot serialise the state")?;
        {
            let mut file = open_private(&temp)?;
            file.write_all(&json)?;
            file.sync_all().ok();
        }
        fs::rename(&temp, path).with_context(|| format!("cannot replace {}", path.display()))?;
        Ok(())
    }
}

#[cfg(unix)]
fn open_private(path: &Path) -> Result<fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("cannot write {}", path.display()))?;
    // The mode above only applies to new files; make sure an older temp file is private too.
    file.set_permissions(fs::Permissions::from_mode(0o600)).ok();
    Ok(file)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("cannot write {}", path.display()))
}
