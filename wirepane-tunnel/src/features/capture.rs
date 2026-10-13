//! pcap export (T8): writes the tunnel's IP packets to a .pcapng file Wireshark can open.
//!
//! File layout (pcapng, always little endian):
//!
//! - one Section Header Block, with the application name;
//! - one Interface Description Block per phone, written the first time that phone sends or gets
//!   a packet, with the peer name in `if_name` and microsecond timestamps in `if_tsresol`, so
//!   Wireshark can filter by phone (`frame.interface_name == "p1"`);
//! - one Enhanced Packet Block per IP packet, with the direction in `epb_flags`.
//!
//! The link type is LINKTYPE_RAW (101): the data of a packet is the IP header and what follows,
//! and the first nibble says IPv4 or IPv6. The tunnel only carries IPv4 today, but raw IP keeps
//! the file valid on the day IPv6 packets come through.
//!
//! Writes are buffered, so a busy tunnel doesn't make one system call per packet. The buffer is
//! flushed in `finish()`, when the writer is dropped, right after the file is created (so it is a
//! valid capture from the first moment) and, while packets keep coming, about once a second. The
//! sidecar leaves with `process::exit`, which runs no destructors: a capture that is still open
//! then loses at most the last second, and the file still ends on a whole block.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::Direction;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureSummary {
    pub path: PathBuf,
    pub packets: u64,
    pub bytes: u64,
}

const BLOCK_SECTION_HEADER: u32 = 0x0A0D_0D0A;
const BLOCK_INTERFACE_DESCRIPTION: u32 = 0x0000_0001;
const BLOCK_ENHANCED_PACKET: u32 = 0x0000_0006;
const BYTE_ORDER_MAGIC: u32 = 0x1A2B_3C4D;

const OPTION_END: u16 = 0;
const OPTION_IF_NAME: u16 = 2;
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
    /// Set by a failed write. After it no more blocks are added, so the damage stays at the
    /// end of the file instead of a half block sitting in the middle of good ones.
    failed: bool,
    last_flush: Instant,
}

impl PcapWriter {
    /// Creates the file (and its folders) and writes the section header. The file is private to
    /// the user, because a capture holds everything the phone sent.
    pub fn create(path: &Path) -> io::Result<Self> {
        if let Some(folder) = path.parent().filter(|folder| !folder.as_os_str().is_empty()) {
            std::fs::create_dir_all(folder)?;
        }
        let mut writer = PcapWriter {
            path: path.to_path_buf(),
            out: BufWriter::with_capacity(WRITE_BUFFER_BYTES, open_private(path)?),
            interfaces: HashMap::new(),
            block: Vec::with_capacity(2048),
            packets: 0,
            bytes: 0,
            failed: false,
            last_flush: Instant::now(),
        };
        writer.write_section_header()?;
        writer.flush_now()?;
        Ok(writer)
    }

    /// One IP packet of one phone. `peer` is the phone's name in the file; the first packet of
    /// a phone adds its interface. An empty packet is not a packet, so it is skipped.
    pub fn write_packet(&mut self, peer: &str, direction: Direction, ip_packet: &[u8], at: SystemTime) -> io::Result<()> {
        if self.failed {
            return Err(io::Error::other("the capture file can not be written any more"));
        }
        if ip_packet.is_empty() {
            return Ok(());
        }
        let interface_id = self.interface_id(peer)?;

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
        Ok(CaptureSummary { path: self.path, packets: self.packets, bytes: self.bytes })
    }

    pub fn path(&self) -> &Path {
        &self.path
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
    fn interface_id(&mut self, peer: &str) -> io::Result<u32> {
        if let Some(id) = self.interfaces.get(peer) {
            return Ok(*id);
        }
        let id = u32::try_from(self.interfaces.len()).map_err(|_| io::Error::other("too many interfaces in one capture"))?;

        begin_block(&mut self.block, BLOCK_INTERFACE_DESCRIPTION);
        put_u16(&mut self.block, LINK_TYPE_RAW);
        put_u16(&mut self.block, 0); // reserved
        put_u32(&mut self.block, SNAP_LENGTH);
        put_option(&mut self.block, OPTION_IF_NAME, cut_on_char_boundary(peer, MAX_INTERFACE_NAME_BYTES).as_bytes());
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
        let result = self.out.write_all(&self.block);
        if result.is_err() {
            self.failed = true;
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

fn open_private(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, FILE_MODE_OWNER_ONLY);
    options.open(path)
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
        assert_eq!(summary, CaptureSummary { path: path.clone(), packets: 0, bytes: 0 });

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
        assert_eq!(summary, CaptureSummary { path, packets: 2, bytes: 160 });
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
