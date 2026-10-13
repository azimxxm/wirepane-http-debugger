//! pcap export (T8): writes the tunnel's IP packets to a .pcapng file Wireshark can open.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::Direction;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureSummary {
    pub path: PathBuf,
    pub packets: u64,
    pub bytes: u64,
}

#[derive(Debug)]
pub struct PcapWriter {
    path: PathBuf,
    _file: File,
    packets: u64,
    bytes: u64,
}

impl PcapWriter {
    pub fn create(path: &Path) -> io::Result<Self> {
        Ok(PcapWriter { path: path.to_path_buf(), _file: File::create(path)?, packets: 0, bytes: 0 })
    }

    /// One IP packet of one phone. Stub: only counts it.
    pub fn write_packet(&mut self, _peer: &str, _direction: Direction, ip_packet: &[u8], _at: SystemTime) -> io::Result<()> {
        self.packets += 1;
        self.bytes += ip_packet.len() as u64;
        Ok(())
    }

    pub fn finish(self) -> io::Result<CaptureSummary> {
        Ok(CaptureSummary { path: self.path, packets: self.packets, bytes: self.bytes })
    }
}
