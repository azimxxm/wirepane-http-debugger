//! pcap export (T8): writes the tunnel's IP packets to a .pcapng file Wireshark can open.
//!
//! File layout (pcapng, always little endian):
//!
//! - one Section Header Block, with the application name;
//! - one Interface Description Block per phone, written the first time that phone sends or gets
//!   a packet, with the phone's name in `if_name`, its peer id in `if_description` and microsecond
//!   timestamps in `if_tsresol`, so Wireshark can filter by phone (`frame.interface_name ==
//!   "iPhone"` or `frame.interface_description == "p1"`);
//! - one Enhanced Packet Block per IP packet, with the direction in `epb_flags`.
//!
//! The link type is LINKTYPE_RAW (101): the data of a packet is the IP header and what follows,
//! and the first nibble says IPv4 or IPv6. The tunnel only carries IPv4 today, but raw IP keeps
//! the file valid on the day IPv6 packets come through.
//!
//! Writes are buffered, so a busy tunnel doesn't make one system call per packet. The buffer is
//! flushed in `finish()`, when the writer is dropped, right after the file is created (so it is a
//! valid capture from the first moment) and, while packets keep coming, about once a second. The
//! sidecar leaves with `process::exit`, which runs no destructors, so it finishes a running capture
//! first (`Tunnel::shutdown`); a process that is killed still loses at most the last second, and
//! the file still ends on a whole block.
//!
//! A capture never replaces an earlier file (`create` takes the next free numbered name) and
//! stops by itself at `MAX_CAPTURE_BYTES`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::Direction;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureSummary {
    pub path: PathBuf,
    pub packets: u64,
    pub bytes: u64,
    /// Why the capture ended on its own ("size limit", "helper stopped"); `None` when the owner stopped it.
    pub reason: Option<&'static str>,
}

impl CaptureSummary {
    /// The `capture-stopped` event, with `reason` when the capture ended on its own.
    pub fn to_event(&self) -> Value {
        let mut event = json!({
            "event": "capture-stopped",
            "path": self.path.to_string_lossy(),
            "packets": self.packets,
            "bytes": self.bytes,
        });
        if let (Some(object), Some(reason)) = (event.as_object_mut(), self.reason) {
            object.insert("reason".to_string(), json!(reason));
        }
        event
    }
}

const BLOCK_SECTION_HEADER: u32 = 0x0A0D_0D0A;
const BLOCK_INTERFACE_DESCRIPTION: u32 = 0x0000_0001;
const BLOCK_ENHANCED_PACKET: u32 = 0x0000_0006;
const BYTE_ORDER_MAGIC: u32 = 0x1A2B_3C4D;

const OPTION_END: u16 = 0;
const OPTION_IF_NAME: u16 = 2;
const OPTION_IF_DESCRIPTION: u16 = 3;
const OPTION_EPB_FLAGS: u16 = 2;
const OPTION_SHB_USERAPPL: u16 = 4;
const OPTION_IF_TSRESOL: u16 = 9;

/// LINKTYPE_RAW: raw IPv4 or IPv6, no link layer.
const LINK_TYPE_RAW: u16 = 101;
/// `if_tsresol` 6 means a timestamp unit of 10^-6 s. It is also the default, but a reader
/// should not have to guess.
const TIMESTAMP_RESOLUTION_MICROSECONDS: u8 = 6;
/// epb_flags bits 0-1: 01 = inbound, 10 = outbound, seen from the Mac the capture runs on.
const FLAGS_INBOUND: u32 = 0b01;
const FLAGS_OUTBOUND: u32 = 0b10;
/// The longest IP packet there is. Longer input (it should never happen) is cut to this, and
/// the block still says how long the packet really was.
const SNAP_LENGTH: u32 = 65_535;
/// An option value is at most 65535 bytes; a peer name never needs more than this.
const MAX_INTERFACE_NAME_BYTES: usize = 255;
const WRITE_BUFFER_BYTES: usize = 64 * 1024;
/// A capture stops at this file size (headers included), so a phone that streams for hours can't fill the disk.
pub const MAX_CAPTURE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// A taken file name is followed by `-2`, `-3`... up to this number; then `create` gives up.
const MAX_NAME_NUMBER: u32 = 1000;
/// How long written packets may wait in the buffer while the capture runs.
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(unix)]
const FILE_MODE_OWNER_ONLY: u32 = 0o600;

#[derive(Debug)]
pub struct PcapWriter {
    path: PathBuf,
    out: BufWriter<File>,
    /// Peer name -> interface id (the order its Interface Description Block was written in).
    interfaces: HashMap<String, u32>,
    /// One block is built here and written in one go, so the same memory serves every packet.
    block: Vec<u8>,
    packets: u64,
    bytes: u64,
    /// Bytes of blocks written so far: the size the file will have once the buffer is flushed.
    file_bytes: u64,
    max_file_bytes: u64,
    /// Set when the next block would pass `max_file_bytes`. The file stays a valid capture of
    /// everything up to there.
    full: bool,
    /// Set by a failed write. After it no more blocks are added, so the damage stays at the
    /// end of the file instead of a half block sitting in the middle of good ones.
    failed: bool,
    last_flush: Instant,
}

impl PcapWriter {
    /// Creates the file (and its folders) and writes the section header. The file is private to
    /// the user, because a capture holds everything the phone sent. It never replaces a file: when
    /// the name is taken, the capture goes to `name-2`, `name-3`... (before the extension), and
    /// `path()` says where it really is.
    pub fn create(path: &Path) -> io::Result<Self> {
        if let Some(folder) = path.parent().filter(|folder| !folder.as_os_str().is_empty()) {
            std::fs::create_dir_all(folder)?;
        }
        let (file, path) = open_new_private(path)?;
        let mut writer = PcapWriter {
            path,
            out: BufWriter::with_capacity(WRITE_BUFFER_BYTES, file),
            interfaces: HashMap::new(),
            block: Vec::with_capacity(2048),
            packets: 0,
            bytes: 0,
            file_bytes: 0,
            max_file_bytes: MAX_CAPTURE_BYTES,
            full: false,
            failed: false,
            last_flush: Instant::now(),
        };
        writer.write_section_header()?;
        writer.flush_now()?;
        Ok(writer)
    }

    /// One IP packet of one phone. `peer` is the phone's id; the first packet of a phone adds its
    /// interface, named after the id. An empty packet is not a packet, so it is skipped.
    pub fn write_packet(&mut self, peer: &str, direction: Direction, ip_packet: &[u8], at: SystemTime) -> io::Result<()> {
        self.write_packet_named(peer, direction, ip_packet, at, |_| None)
    }

    /// Like `write_packet`, with the phone's name: when the phone is first seen, `name_of(peer)` gives
    /// the `if_name` of its interface ("iPhone"), and its id becomes the `if_description` ("p42").
    /// Without a name the id is used for both.
    pub fn write_packet_named(
        &mut self,
        peer: &str,
        direction: Direction,
        ip_packet: &[u8],
        at: SystemTime,
        name_of: impl FnOnce(&str) -> Option<String>,
    ) -> io::Result<()> {
        if self.full {
            return Err(size_limit_error());
        }
        if self.failed {
            return Err(io::Error::other("the capture file can not be written any more"));
        }
        if ip_packet.is_empty() {
            return Ok(());
        }
        let interface_id = self.interface_id(peer, name_of)?;

        let timestamp = micros_since_epoch(at);
        let captured = &ip_packet[..ip_packet.len().min(SNAP_LENGTH as usize)];
        let flags = match direction {
            Direction::FromPhone => FLAGS_INBOUND,
            Direction::ToPhone => FLAGS_OUTBOUND,
        };

        begin_block(&mut self.block, BLOCK_ENHANCED_PACKET);
        put_u32(&mut self.block, interface_id);
        put_u32(&mut self.block, (timestamp >> 32) as u32);
        put_u32(&mut self.block, timestamp as u32);
        put_u32(&mut self.block, captured.len() as u32);
        put_u32(&mut self.block, u32::try_from(ip_packet.len()).unwrap_or(u32::MAX));
        self.block.extend_from_slice(captured);
        pad_to_32_bits(&mut self.block);
        put_option(&mut self.block, OPTION_EPB_FLAGS, &flags.to_le_bytes());
        put_option(&mut self.block, OPTION_END, &[]);
        finish_block(&mut self.block);
        self.write_block()?;

        self.packets += 1;
        self.bytes += ip_packet.len() as u64;

        if self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush_now()?;
        }
        Ok(())
    }

    /// Flushes what is buffered and closes the file. An error means the file is incomplete.
    pub fn finish(mut self) -> io::Result<CaptureSummary> {
        self.flush_now()?;
        if self.failed {
            return Err(io::Error::other("the capture file is incomplete: a write failed"));
        }
        Ok(CaptureSummary { path: self.path, packets: self.packets, bytes: self.bytes, reason: None })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True once the capture has reached `MAX_CAPTURE_BYTES`: no more packets are taken, and
    /// `finish()` still gives a valid file.
    pub fn is_full(&self) -> bool {
        self.full
    }

    /// A smaller size limit than `MAX_CAPTURE_BYTES`, so tests can reach it.
    #[cfg(test)]
    pub(crate) fn with_size_limit(mut self, bytes: u64) -> Self {
        self.max_file_bytes = bytes;
        self
    }

    /// Packets written so far, for a live counter.
    pub fn packets(&self) -> u64 {
        self.packets
    }

    /// IP bytes written so far (the real packet sizes), for a live counter.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    fn write_section_header(&mut self) -> io::Result<()> {
        let application = concat!("wirepane-tunnel ", env!("CARGO_PKG_VERSION"));
        begin_block(&mut self.block, BLOCK_SECTION_HEADER);
        put_u32(&mut self.block, BYTE_ORDER_MAGIC);
        put_u16(&mut self.block, 1); // major version
        put_u16(&mut self.block, 0); // minor version
        self.block.extend_from_slice(&(-1i64).to_le_bytes()); // section length: not known, the file just ends
        put_option(&mut self.block, OPTION_SHB_USERAPPL, application.as_bytes());
        put_option(&mut self.block, OPTION_END, &[]);
        finish_block(&mut self.block);
        self.write_block()
    }

    /// The id of a phone's interface, adding the interface the first time the phone shows up.
    fn interface_id(&mut self, peer: &str, name_of: impl FnOnce(&str) -> Option<String>) -> io::Result<u32> {
        if let Some(id) = self.interfaces.get(peer) {
            return Ok(*id);
        }
        let id = u32::try_from(self.interfaces.len()).map_err(|_| io::Error::other("too many interfaces in one capture"))?;
        let name = name_of(peer).filter(|name| !name.is_empty());
        let name = name.as_deref().unwrap_or(peer);

        begin_block(&mut self.block, BLOCK_INTERFACE_DESCRIPTION);
        put_u16(&mut self.block, LINK_TYPE_RAW);
        put_u16(&mut self.block, 0); // reserved
        put_u32(&mut self.block, SNAP_LENGTH);
        put_option(&mut self.block, OPTION_IF_NAME, cut_on_char_boundary(name, MAX_INTERFACE_NAME_BYTES).as_bytes());
        put_option(&mut self.block, OPTION_IF_DESCRIPTION, cut_on_char_boundary(peer, MAX_INTERFACE_NAME_BYTES).as_bytes());
        put_option(&mut self.block, OPTION_IF_TSRESOL, &[TIMESTAMP_RESOLUTION_MICROSECONDS]);
        put_option(&mut self.block, OPTION_END, &[]);
        finish_block(&mut self.block);
        self.write_block()?;

        // Only remembered once the block is written, so a failed write doesn't leave an interface
        // in the map that the file doesn't have.
        self.interfaces.insert(peer.to_string(), id);
        Ok(id)
    }

    fn write_block(&mut self) -> io::Result<()> {
        let block_bytes = self.block.len() as u64;
        if self.file_bytes.saturating_add(block_bytes) > self.max_file_bytes {
            self.full = true;
            return Err(size_limit_error());
        }
        let result = self.out.write_all(&self.block);
        match result {
            Ok(()) => self.file_bytes += block_bytes,
            Err(_) => self.failed = true,
        }
        result
    }

    fn flush_now(&mut self) -> io::Result<()> {
        let result = self.out.flush();
        if result.is_err() {
            self.failed = true;
        }
        self.last_flush = Instant::now();
        result
    }
}

/// Opens a file that did not exist before (`create_new`, so no capture can replace an earlier one, or
/// follow a link someone left there). A taken name is followed by `-2`, `-3`...; the path that
/// worked comes back with the file. Anything else in the way, such as a folder, is an error.
fn open_new_private(path: &Path) -> io::Result<(File, PathBuf)> {
    let mut candidate = path.to_path_buf();
    let mut number = 1;
    loop {
        match open_private(&candidate) {
            Ok(file) => return Ok((file, candidate)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && is_taken_by_a_file(&candidate) && number < MAX_NAME_NUMBER => {
                number += 1;
                candidate = numbered_name(path, number);
            }
            Err(error) => return Err(error),
        }
    }
}

/// A file or a link (a dangling one too), not a folder.
fn is_taken_by_a_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.is_dir())
}

/// `dir/a.pcapng` and 2 give `dir/a-2.pcapng`.
fn numbered_name(path: &Path, number: u32) -> PathBuf {
    let mut name = path.file_stem().map(OsStr::to_os_string).unwrap_or_default();
    name.push(format!("-{number}"));
    if let Some(extension) = path.extension() {
        name.push(".");
        name.push(extension);
    }
    path.with_file_name(name)
}

fn open_private(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, FILE_MODE_OWNER_ONLY);
    options.open(path)
}

fn size_limit_error() -> io::Error {
    io::Error::new(io::ErrorKind::FileTooLarge, "the capture reached its size limit")
}

/// Microseconds since 1970. A clock set before 1970 gives 0 rather than a panic or an error,
/// because a wrong clock should not stop a capture.
fn micros_since_epoch(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map(|since_epoch| u64::try_from(since_epoch.as_micros()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn cut_on_char_boundary(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Starts a block in `out` (which is emptied first): the type, then a length that
/// `finish_block` fills in.
fn begin_block(out: &mut Vec<u8>, block_type: u32) {
    out.clear();
    put_u32(out, block_type);
    put_u32(out, 0);
}

/// Every block starts and ends with its total length, so a reader can walk the file both ways.
fn finish_block(out: &mut Vec<u8>) {
    let total_length = (out.len() + 4) as u32;
    out[4..8].copy_from_slice(&total_length.to_le_bytes());
    put_u32(out, total_length);
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_option(out: &mut Vec<u8>, code: u16, value: &[u8]) {
    put_u16(out, code);
    put_u16(out, value.len() as u16);
    out.extend_from_slice(value);
    pad_to_32_bits(out);
}

/// Block data and option values are padded with zeros to a multiple of 4 bytes. Blocks are built
/// from offset 0, so the length of `out` is the offset in the block.
fn pad_to_32_bits(out: &mut Vec<u8>) {
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::process::Command;
    use std::time::Duration;

    // ---- A small pcapng reader, written separately from the writer so the tests check the
    // ---- bytes against the format and not against the writer's own idea of it.

    fn u16_at(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    struct RawBlock {
        block_type: u32,
        body: Vec<u8>,
    }

    /// Splits the file into blocks, checking that each one's length is a multiple of 4, is
    /// repeated at its end, and that the blocks fill the file exactly.
    fn read_blocks(bytes: &[u8]) -> Vec<RawBlock> {
        let mut blocks = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            assert!(bytes.len() - at >= 12, "a block header is cut off at byte {at}");
            let block_type = u32_at(bytes, at);
            let total = u32_at(bytes, at + 4) as usize;
            assert!(total >= 12 && total.is_multiple_of(4), "bad block length {total} at byte {at}");
            assert!(at + total <= bytes.len(), "the block at byte {at} runs past the end of the file");
            assert_eq!(u32_at(bytes, at + total - 4) as usize, total, "the closing length of the block at byte {at}");
            blocks.push(RawBlock { block_type, body: bytes[at + 8..at + total - 4].to_vec() });
            at += total;
        }
        blocks
    }

    /// Options up to opt_endofopt, which has to be the last thing in the block.
    fn read_options(mut bytes: &[u8]) -> Vec<(u16, Vec<u8>)> {
        let mut options = Vec::new();
        loop {
            assert!(bytes.len() >= 4, "options without opt_endofopt");
            let code = u16_at(bytes, 0);
            let length = u16_at(bytes, 2) as usize;
            if code == 0 {
                assert_eq!(length, 0);
                assert_eq!(bytes.len(), 4, "nothing may follow opt_endofopt");
                return options;
            }
            let padded = (length + 3) & !3;
            options.push((code, bytes[4..4 + length].to_vec()));
            bytes = &bytes[4 + padded..];
        }
    }

    #[derive(Debug)]
    struct ReadInterface {
        link_type: u16,
        snap_length: u32,
        name: String,
        description: Option<String>,
        timestamp_resolution: Option<u8>,
    }

    #[derive(Debug)]
    struct ReadPacket {
        interface: u32,
        micros: u64,
        original_length: u32,
        data: Vec<u8>,
        flags: Option<u32>,
    }

    #[derive(Debug)]
    struct ReadCapture {
        application: String,
        interfaces: Vec<ReadInterface>,
        packets: Vec<ReadPacket>,
    }

    fn read_capture(path: &Path) -> ReadCapture {
        let bytes = std::fs::read(path).unwrap();
        let blocks = read_blocks(&bytes);

        let header = &blocks[0];
        assert_eq!(header.block_type, 0x0A0D_0D0A, "a pcapng file starts with a section header");
        assert_eq!(u32_at(&header.body, 0), 0x1A2B_3C4D, "byte-order magic");
        assert_eq!((u16_at(&header.body, 4), u16_at(&header.body, 6)), (1, 0), "version");
        assert_eq!(header.body[8..16], (-1i64).to_le_bytes(), "section length");
        let header_options = read_options(&header.body[16..]);
        let application = header_options
            .iter()
            .find(|(code, _)| *code == 4)
            .map(|(_, value)| String::from_utf8(value.clone()).unwrap())
            .expect("shb_userappl");

        let mut interfaces = Vec::new();
        let mut packets = Vec::new();
        for block in &blocks[1..] {
            match block.block_type {
                1 => {
                    let options = read_options(&block.body[8..]);
                    let find = |code: u16| options.iter().find(|(c, _)| *c == code).map(|(_, value)| value.clone());
                    assert_eq!(u16_at(&block.body, 2), 0, "reserved");
                    interfaces.push(ReadInterface {
                        link_type: u16_at(&block.body, 0),
                        snap_length: u32_at(&block.body, 4),
                        name: String::from_utf8(find(2).expect("if_name")).unwrap(),
                        description: find(3).map(|value| String::from_utf8(value).unwrap()),
                        timestamp_resolution: find(9).map(|value| {
                            assert_eq!(value.len(), 1);
                            value[0]
                        }),
                    });
                }
                6 => {
                    let interface = u32_at(&block.body, 0);
                    assert!((interface as usize) < interfaces.len(), "a packet on interface {interface} before it is described");
                    let micros = (u64::from(u32_at(&block.body, 4)) << 32) | u64::from(u32_at(&block.body, 8));
                    let captured = u32_at(&block.body, 12) as usize;
                    let original_length = u32_at(&block.body, 16);
                    assert!(captured <= original_length as usize);
                    assert!(captured <= interfaces[interface as usize].snap_length as usize);
                    let padded = (captured + 3) & !3;
                    let options = read_options(&block.body[20 + padded..]);
                    packets.push(ReadPacket {
                        interface,
                        micros,
                        original_length,
                        data: block.body[20..20 + captured].to_vec(),
                        flags: options.iter().find(|(code, _)| *code == 2).map(|(_, value)| u32::from_le_bytes(value[..4].try_into().unwrap())),
                    });
                }
                other => panic!("unexpected block type {other:#x}"),
            }
        }
        ReadCapture { application, interfaces, packets }
    }

    fn at_micros(micros: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_micros(micros)
    }

    /// A real IPv4 + UDP packet (from `src` to `dst:port`), so external tools can decode it.
    fn udp_packet(src: [u8; 4], dst: [u8; 4], port: u16, payload: &[u8]) -> Vec<u8> {
        let total = 20 + 8 + payload.len();
        let mut packet = vec![0x45, 0, (total >> 8) as u8, total as u8, 0, 0, 0x40, 0, 64, 17, 0, 0];
        packet.extend_from_slice(&src);
        packet.extend_from_slice(&dst);
        // The IPv4 header checksum: the ones' complement of the sum of its 16-bit words.
        let mut sum: u32 = packet[..20].chunks(2).map(|pair| u32::from(u16::from_be_bytes([pair[0], pair[1]]))).sum();
        while sum > 0xFFFF {
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        packet[10..12].copy_from_slice(&(!(sum as u16)).to_be_bytes());
        packet.extend_from_slice(&40_000u16.to_be_bytes()); // source port
        packet.extend_from_slice(&port.to_be_bytes());
        packet.extend_from_slice(&((8 + payload.len()) as u16).to_be_bytes());
        packet.extend_from_slice(&[0, 0]); // UDP checksum: 0 = not used
        packet.extend_from_slice(payload);
        packet
    }

    #[test]
    fn an_empty_capture_is_a_valid_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("empty.pcapng");
        let summary = PcapWriter::create(&path).unwrap().finish().unwrap();
        assert_eq!(summary, CaptureSummary { path: path.clone(), packets: 0, bytes: 0, reason: None });

        let capture = read_capture(&path);
        assert!(capture.application.starts_with("wirepane-tunnel "), "{}", capture.application);
        assert!(capture.interfaces.is_empty());
        assert!(capture.packets.is_empty());
    }

    #[test]
    fn each_phone_gets_an_interface_with_its_name() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("two-phones.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[0x45, 1, 2, 3], at_micros(1_000_000)).unwrap();
        writer.write_packet("p2", Direction::FromPhone, &[0x45, 4, 5, 6], at_micros(2_000_000)).unwrap();
        writer.write_packet("p1", Direction::ToPhone, &[0x45, 7, 8, 9], at_micros(3_000_000)).unwrap();
        writer.finish().unwrap();

        let capture = read_capture(&path);
        let described: Vec<_> = capture
            .interfaces
            .iter()
            .map(|interface| (interface.name.as_str(), interface.link_type, interface.snap_length, interface.timestamp_resolution))
            .collect();
        assert_eq!(described, vec![("p1", 101, 65_535, Some(6)), ("p2", 101, 65_535, Some(6))]);

        let placed: Vec<_> = capture.packets.iter().map(|packet| (packet.interface, packet.data.clone())).collect();
        assert_eq!(placed, vec![(0, vec![0x45, 1, 2, 3]), (1, vec![0x45, 4, 5, 6]), (0, vec![0x45, 7, 8, 9])]);
    }

    #[test]
    fn the_direction_is_inbound_from_the_phone_and_outbound_to_it() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("direction.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[0x45], at_micros(1)).unwrap();
        writer.write_packet("p1", Direction::ToPhone, &[0x45], at_micros(2)).unwrap();
        writer.finish().unwrap();

        let flags: Vec<_> = read_capture(&path).packets.iter().map(|packet| packet.flags).collect();
        assert_eq!(flags, vec![Some(0b01), Some(0b10)]);
    }

    #[test]
    fn timestamps_are_whole_microseconds_across_the_32_bit_split() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("time.pcapng");
        // 2026-10-13 in microseconds is far above 2^32, so the high and low words both matter.
        let moment = 1_791_809_205_123_456u64;
        assert!(moment > u64::from(u32::MAX));
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[0x45], at_micros(moment)).unwrap();
        // Sub-microsecond parts are dropped, not rounded up into the next microsecond.
        writer.write_packet("p1", Direction::FromPhone, &[0x45], at_micros(moment) + Duration::from_nanos(999)).unwrap();
        writer.finish().unwrap();

        let times: Vec<_> = read_capture(&path).packets.iter().map(|packet| packet.micros).collect();
        assert_eq!(times, vec![moment, moment]);
    }

    #[test]
    fn a_clock_before_1970_is_written_as_zero() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("old.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[0x45], UNIX_EPOCH - Duration::from_secs(5)).unwrap();
        writer.finish().unwrap();
        assert_eq!(read_capture(&path).packets[0].micros, 0);
    }

    #[test]
    fn every_packet_length_is_padded_to_32_bits_and_comes_back_exact() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("padding.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        let packets: Vec<Vec<u8>> = (1..=17u8).map(|length| (0..length).map(|i| i.wrapping_mul(7).wrapping_add(length)).collect()).collect();
        for packet in &packets {
            writer.write_packet("p1", Direction::FromPhone, packet, at_micros(10)).unwrap();
        }
        writer.finish().unwrap();

        let read: Vec<_> = read_capture(&path).packets.into_iter().map(|packet| packet.data).collect();
        assert_eq!(read, packets);
    }

    #[test]
    fn the_summary_counts_packets_and_the_real_bytes() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("summary.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[0x45; 100], at_micros(1)).unwrap();
        writer.write_packet("p2", Direction::ToPhone, &[0x45; 60], at_micros(2)).unwrap();
        // The live counters match what finish() reports.
        assert_eq!((writer.packets(), writer.bytes()), (2, 160));
        assert_eq!(writer.path(), path.as_path());
        let summary = writer.finish().unwrap();
        assert_eq!(summary, CaptureSummary { path, packets: 2, bytes: 160, reason: None });
    }

    #[test]
    fn an_empty_packet_is_skipped() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("skip.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[], at_micros(1)).unwrap();
        let summary = writer.finish().unwrap();
        assert_eq!((summary.packets, summary.bytes), (0, 0));
        let capture = read_capture(&path);
        assert!(capture.packets.is_empty());
        assert!(capture.interfaces.is_empty(), "a skipped packet should not add its phone");
    }

    #[test]
    fn a_packet_longer_than_the_snap_length_is_cut_but_keeps_its_real_length() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("long.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &vec![0x45; 70_000], at_micros(1)).unwrap();
        let summary = writer.finish().unwrap();
        assert_eq!(summary.bytes, 70_000);

        let packet = &read_capture(&path).packets[0];
        assert_eq!(packet.data.len(), 65_535);
        assert_eq!(packet.original_length, 70_000);
    }

    #[test]
    fn many_packets_get_through_the_write_buffer_in_order() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("many.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        let count = 20_000u32;
        for number in 0..count {
            let mut packet = vec![0x45; 100];
            packet[4..8].copy_from_slice(&number.to_be_bytes());
            let peer = if number % 3 == 0 { "p1" } else { "p2" };
            writer.write_packet(peer, Direction::FromPhone, &packet, at_micros(u64::from(number))).unwrap();
        }
        let summary = writer.finish().unwrap();
        assert_eq!((summary.packets, summary.bytes), (u64::from(count), u64::from(count) * 100));
        // 20,000 packets is about 2.4 MB, many times the 64 KiB buffer
        assert!(std::fs::metadata(&path).unwrap().len() > 2_000_000);

        let capture = read_capture(&path);
        assert_eq!(capture.packets.len(), count as usize);
        for (number, packet) in capture.packets.iter().enumerate() {
            assert_eq!(u32::from_be_bytes(packet.data[4..8].try_into().unwrap()), number as u32);
            assert_eq!(packet.micros, number as u64);
            assert_eq!(capture.interfaces[packet.interface as usize].name, if number % 3 == 0 { "p1" } else { "p2" });
        }
    }

    #[test]
    fn a_long_name_is_cut_on_a_character_boundary() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("name.pcapng");
        let name = "é".repeat(300); // 600 bytes, each character 2 bytes
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet(&name, Direction::FromPhone, &[0x45], at_micros(1)).unwrap();
        // The same long name is still one interface the second time
        writer.write_packet(&name, Direction::ToPhone, &[0x45], at_micros(2)).unwrap();
        writer.finish().unwrap();

        let capture = read_capture(&path);
        assert_eq!(capture.interfaces.len(), 1);
        assert_eq!(capture.interfaces[0].name, "é".repeat(127)); // 254 bytes, the last whole character that fits
    }

    #[test]
    fn missing_folders_are_created_and_the_file_is_private() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("captures").join("deeper").join("run.pcapng");
        PcapWriter::create(&path).unwrap().finish().unwrap();
        assert!(path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_path_that_can_not_be_created_is_an_error() {
        let folder = tempfile::tempdir().unwrap();
        // A folder where the file should be
        assert!(PcapWriter::create(folder.path()).is_err());
    }

    #[test]
    fn finish_flushes_what_the_buffer_still_holds() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("flush.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        let header_only = std::fs::metadata(&path).unwrap().len();
        writer.write_packet("p1", Direction::FromPhone, &[0x45; 40], at_micros(1)).unwrap();
        // A packet is far below the buffer size and the flush interval is not over, so only the
        // buffer holds it
        assert_eq!(std::fs::metadata(&path).unwrap().len(), header_only, "the packet should still be in the buffer");
        writer.finish().unwrap();
        assert_eq!(read_capture(&path).packets.len(), 1);
    }

    #[test]
    fn the_file_is_a_valid_empty_capture_from_the_moment_it_is_created() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("fresh.pcapng");
        let writer = PcapWriter::create(&path).unwrap();
        // Nothing was finished or dropped yet. A sidecar that is killed now leaves this file.
        let capture = read_capture(&path);
        assert!(capture.application.starts_with("wirepane-tunnel "));
        assert!(capture.packets.is_empty());
        drop(writer);
    }

    #[test]
    fn a_running_capture_is_flushed_once_the_interval_is_over() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("interval.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[0x45; 40], at_micros(1)).unwrap();
        assert!(read_capture(&path).packets.is_empty(), "inside the interval the packet waits in the buffer");

        // The interval passes (the writer is told it was last flushed long ago), and the next packet flushes both
        writer.last_flush = Instant::now() - FLUSH_INTERVAL - Duration::from_millis(1);
        writer.write_packet("p2", Direction::ToPhone, &[0x45; 60], at_micros(2)).unwrap();

        // Not finished, not dropped: this is what a killed process would leave
        let capture = read_capture(&path);
        assert_eq!(capture.packets.len(), 2);
        assert_eq!(capture.interfaces.len(), 2);
        std::mem::forget(writer);
    }

    #[test]
    fn a_killed_process_leaves_a_file_that_ends_on_a_block_boundary() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("killed.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        for number in 0..3_000u64 {
            writer.write_packet("p1", Direction::FromPhone, &[0x45; 100], at_micros(number)).unwrap();
        }
        // The process dies: nothing flushes the buffer and nothing runs finish().
        std::mem::forget(writer);

        // What reached the disk is whole blocks (read_blocks checks that they fill the file exactly),
        // so Wireshark can open the capture up to the last flushed packet.
        let capture = read_capture(&path);
        assert_eq!(capture.interfaces.len(), 1);
        assert!(!capture.packets.is_empty(), "the buffer fills up and is written on its way");
        assert!(capture.packets.len() < 3_000, "the last packets were still in the buffer");
    }

    #[test]
    fn after_a_failed_write_no_more_blocks_are_added_and_finish_says_the_file_is_incomplete() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("failed.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        writer.write_packet("p1", Direction::FromPhone, &[0x45; 20], at_micros(1)).unwrap();
        // What write_block does when the disk says no
        writer.failed = true;

        assert!(writer.write_packet("p1", Direction::FromPhone, &[0x45; 20], at_micros(2)).is_err());
        assert_eq!(writer.packets(), 1, "a refused packet is not counted");
        assert!(writer.finish().is_err());

        // The file still holds the packet from before and is a valid capture
        assert_eq!(read_capture(&path).packets.len(), 1);
    }

    #[test]
    fn a_phone_is_named_by_its_device_and_described_by_its_id() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("names.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        let names = |peer: &str| (peer == "p42").then(|| "iPhone".to_string());
        writer.write_packet_named("p42", Direction::FromPhone, &[0x45, 1], at_micros(1), names).unwrap();
        // The name is asked for once, when the phone is first seen
        writer
            .write_packet_named("p42", Direction::ToPhone, &[0x45, 2], at_micros(2), |_| panic!("the name is already known"))
            .unwrap();
        // A phone without a known name is called by its id, and an empty name counts as none
        writer.write_packet_named("p43", Direction::FromPhone, &[0x45, 3], at_micros(3), |_| None).unwrap();
        writer.write_packet_named("p44", Direction::FromPhone, &[0x45, 4], at_micros(4), |_| Some(String::new())).unwrap();
        // Two devices may share a name; the descriptions tell them apart
        writer.write_packet_named("p45", Direction::FromPhone, &[0x45, 5], at_micros(5), |_| Some("iPhone".to_string())).unwrap();
        writer.write_packet("p46", Direction::FromPhone, &[0x45, 6], at_micros(6)).unwrap();
        writer.finish().unwrap();

        let capture = read_capture(&path);
        let described: Vec<_> =
            capture.interfaces.iter().map(|interface| (interface.name.as_str(), interface.description.as_deref())).collect();
        assert_eq!(
            described,
            vec![
                ("iPhone", Some("p42")),
                ("p43", Some("p43")),
                ("p44", Some("p44")),
                ("iPhone", Some("p45")),
                ("p46", Some("p46")),
            ]
        );
        assert_eq!(capture.packets.len(), 6);
    }

    #[test]
    fn a_long_device_name_is_cut_on_a_character_boundary_and_the_id_stays_whole() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("long-name.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        let name = "é".repeat(300);
        writer.write_packet_named("p1", Direction::FromPhone, &[0x45], at_micros(1), |_| Some(name)).unwrap();
        writer.finish().unwrap();
        let interface = &read_capture(&path).interfaces[0];
        assert_eq!(interface.name, "é".repeat(127));
        assert_eq!(interface.description.as_deref(), Some("p1"));
    }

    #[test]
    fn a_second_capture_with_the_same_name_does_not_replace_the_first() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("wirepane-2026-10-13_12-24-27.pcapng");
        let mut first = PcapWriter::create(&path).unwrap();
        first.write_packet("p1", Direction::FromPhone, &[0x45; 40], at_micros(1)).unwrap();
        let first = first.finish().unwrap();
        assert_eq!(first.path, path);
        let first_bytes = std::fs::read(&path).unwrap();

        // The same second: the next free name is used, and the writer says where it really is
        let second = PcapWriter::create(&path).unwrap();
        let third = PcapWriter::create(&path).unwrap();
        assert_eq!(second.path(), folder.path().join("wirepane-2026-10-13_12-24-27-2.pcapng"));
        assert_eq!(third.path(), folder.path().join("wirepane-2026-10-13_12-24-27-3.pcapng"));
        let summary = second.finish().unwrap();
        assert_eq!(summary.path, folder.path().join("wirepane-2026-10-13_12-24-27-2.pcapng"));
        third.finish().unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), first_bytes, "the first capture is untouched");
        assert!(read_capture(&summary.path).packets.is_empty(), "the second one starts empty");
    }

    #[test]
    fn a_name_without_an_extension_is_numbered_too() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("capture");
        PcapWriter::create(&path).unwrap().finish().unwrap();
        let second = PcapWriter::create(&path).unwrap();
        assert_eq!(second.path(), folder.path().join("capture-2"));
        // A numbered name that is taken is skipped as well
        std::fs::write(folder.path().join("capture-3"), "x").unwrap();
        let next = PcapWriter::create(&path).unwrap();
        assert_eq!(next.path(), folder.path().join("capture-4"));
    }

    #[test]
    fn a_folder_or_a_link_in_the_way_is_never_written_through() {
        let folder = tempfile::tempdir().unwrap();
        // A folder with the capture's name is an error, not a reason to pick another name
        let in_the_way = folder.path().join("taken.pcapng");
        std::fs::create_dir(&in_the_way).unwrap();
        assert!(PcapWriter::create(&in_the_way).is_err());
        assert!(!folder.path().join("taken-2.pcapng").exists());

        // A link is a taken name: the capture goes beside it, and the link's target is not touched
        #[cfg(unix)]
        {
            let target = folder.path().join("precious.txt");
            std::fs::write(&target, "keep me").unwrap();
            let link = folder.path().join("linked.pcapng");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let writer = PcapWriter::create(&link).unwrap();
            assert_eq!(writer.path(), folder.path().join("linked-2.pcapng"));
            writer.finish().unwrap();
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me");
        }
    }

    #[test]
    fn a_capture_gives_up_when_every_numbered_name_is_taken() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("full.pcapng");
        std::fs::write(&path, "x").unwrap();
        for number in 2..=MAX_NAME_NUMBER {
            std::fs::write(numbered_name(&path, number), "x").unwrap();
        }
        let error = PcapWriter::create(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x", "nothing was replaced");
    }

    #[test]
    fn the_size_limit_is_two_gibibytes() {
        assert_eq!(MAX_CAPTURE_BYTES, 2_147_483_648);
        let folder = tempfile::tempdir().unwrap();
        let writer = PcapWriter::create(&folder.path().join("limit.pcapng")).unwrap();
        assert_eq!(writer.max_file_bytes, MAX_CAPTURE_BYTES);
    }

    #[test]
    fn a_capture_stops_taking_packets_at_the_size_limit_and_stays_a_valid_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("small.pcapng");
        let limit = 2_000;
        let mut writer = PcapWriter::create(&path).unwrap().with_size_limit(limit);
        assert!(!writer.is_full());

        let mut taken = 0;
        let refused = loop {
            match writer.write_packet("p1", Direction::FromPhone, &[0x45; 100], at_micros(taken)) {
                Ok(()) => taken += 1,
                Err(error) => break error,
            }
            assert!(taken < 1000, "the limit never came");
        };
        assert_eq!(refused.kind(), io::ErrorKind::FileTooLarge);
        assert!(writer.is_full());
        assert!(taken > 5, "a 2 kB limit takes several packets, took {taken}");
        // It stays full: later packets are refused too, and are not counted
        assert!(writer.write_packet("p1", Direction::ToPhone, &[0x45; 20], at_micros(9_999)).is_err());
        assert_eq!(writer.packets(), taken);

        // finish() works: the file ends on a whole block under the limit and holds what was taken
        let summary = writer.finish().unwrap();
        assert_eq!((summary.packets, summary.bytes), (taken, taken * 100));
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size <= limit, "{size} bytes is over the {limit} byte limit");
        assert!(size + 200 > limit, "the file stops where the next packet would not fit, not long before: {size}");
        assert_eq!(read_capture(&path).packets.len() as u64, taken);
    }

    #[test]
    fn a_failed_write_is_not_taken_for_the_size_limit() {
        let folder = tempfile::tempdir().unwrap();
        let mut writer = PcapWriter::create(&folder.path().join("failed.pcapng")).unwrap();
        writer.failed = true;
        assert!(writer.write_packet("p1", Direction::FromPhone, &[0x45], at_micros(1)).is_err());
        assert!(!writer.is_full());
    }

    #[test]
    fn the_stopped_event_names_the_reason_only_when_the_capture_ended_on_its_own() {
        let mut summary = CaptureSummary { path: PathBuf::from("/tmp/a.pcapng"), packets: 3, bytes: 300, reason: None };
        assert_eq!(
            summary.to_event(),
            json!({"event": "capture-stopped", "path": "/tmp/a.pcapng", "packets": 3, "bytes": 300})
        );
        summary.reason = Some("size limit");
        assert_eq!(
            summary.to_event(),
            json!({"event": "capture-stopped", "path": "/tmp/a.pcapng", "packets": 3, "bytes": 300, "reason": "size limit"})
        );
    }

    /// Runs `tool` when it is installed; `None` when it is not.
    fn run_if_installed(tool: &str, args: &[&OsStr]) -> Option<std::process::Output> {
        match Command::new(tool).args(args).output() {
            Ok(output) => Some(output),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                eprintln!("{tool} is not installed, skipping its check");
                None
            }
            Err(error) => panic!("could not run {tool}: {error}"),
        }
    }

    /// Reads the same file with Wireshark's tools and tcpdump, whichever are installed: they are
    /// independent readers of the format, which the in-test reader above can't be.
    #[test]
    fn external_readers_understand_the_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("external.pcapng");
        let mut writer = PcapWriter::create(&path).unwrap();
        let phone_ip = [10, 73, 0, 2];
        let destinations: [([u8; 4], u16); 6] = [([93, 184, 216, 34], 5001), ([1, 1, 1, 1], 5000), ([10, 73, 0, 53], 5002), ([8, 8, 8, 8], 8443), ([93, 184, 216, 34], 9999), ([10, 73, 0, 1], 4242)];
        for (number, (destination, port)) in destinations.iter().enumerate() {
            let peer = if number % 2 == 0 { "p1" } else { "p2" };
            let packet = udp_packet(phone_ip, *destination, *port, b"wirepane");
            writer.write_packet(peer, Direction::FromPhone, &packet, at_micros(1_791_809_205_000_000 + number as u64)).unwrap();
        }
        writer.finish().unwrap();

        if let Some(output) = run_if_installed("tshark", &[OsStr::new("-r"), path.as_os_str(), OsStr::new("-T"), OsStr::new("fields"), OsStr::new("-e"), OsStr::new("ip.dst")]) {
            assert!(output.status.success(), "tshark: {}", String::from_utf8_lossy(&output.stderr));
            let seen: Vec<String> = String::from_utf8_lossy(&output.stdout).lines().map(|line| line.trim().to_string()).collect();
            let expected: Vec<String> = destinations.iter().map(|(ip, _)| format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])).collect();
            assert_eq!(seen, expected);
        }

        if let Some(output) = run_if_installed("capinfos", &[path.as_os_str()]) {
            assert!(output.status.success(), "capinfos: {}", String::from_utf8_lossy(&output.stderr));
            let report = String::from_utf8_lossy(&output.stdout);
            let packets_line = report.lines().find(|line| line.starts_with("Number of packets")).unwrap_or_else(|| panic!("capinfos gave no packet count:\n{report}"));
            assert!(packets_line.split_whitespace().any(|word| word == "6"), "{packets_line}");
        }

        if let Some(output) = run_if_installed("tcpdump", &[OsStr::new("-nn"), OsStr::new("-r"), path.as_os_str()]) {
            let notes = String::from_utf8_lossy(&output.stderr);
            assert!(output.status.success(), "tcpdump: {notes}");
            eprintln!("tcpdump says: {}\n{}", notes.trim(), String::from_utf8_lossy(&output.stdout));
            let lines: Vec<String> = String::from_utf8_lossy(&output.stdout).lines().map(str::to_string).collect();
            assert_eq!(lines.len(), 6, "{lines:#?}");
            assert!(lines[0].contains("10.73.0.2.40000 > 93.184.216.34.5001"), "{}", lines[0]);
            assert!(lines[5].contains("10.73.0.2.40000 > 10.73.0.1.4242"), "{}", lines[5]);
        }
    }
}
