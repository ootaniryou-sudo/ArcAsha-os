//! Akasha-Kernel Binary Protocol (Rust)
//!
//! 48-byte fixed header + raw Float32 payload.
//! Identical wire format to the TypeScript `BinaryCodec` — zero-copy on both ends.
//!
//! ## Byte Layout
//!
//! | Offset | Size | Type   | Field         |
//! |-------:|-----:|--------|---------------|
//! | 0      | 4    | u32 BE | `MAGIC`       |
//! | 4      | 1    | u8     | `VERSION`     |
//! | 5      | 1    | u8     | `COMMAND`     |
//! | 6      | 2    | u16 LE | `FLAGS`       |
//! | 8      | 8    | u64 LE | `TX_ID`       |
//! | 16     | 8    | u64 LE | `NODE_ID`     |
//! | 24     | 4    | u32 LE | `CLUSTER_ID`  |
//! | 28     | 4    | u32 LE | `PAYLOAD_LEN` |
//! | 32     | 8    | u64 LE | `TIMESTAMP_US`|
//! | 40     | 4    | u32 LE | `EXPECTED_US` |
//! | 44     | 4    | u32 LE | `SEQ`          |
//! | **48** | N    | f32[]  | `PAYLOAD`      |

use byteorder::{BigEndian, LittleEndian, ReadBytesExt, WriteBytesExt};
use std::io::Cursor;

/// Magic bytes: "AKSH" in big-endian u32.
pub const MAGIC: u32 = 0x414B_5348;
pub const PROTOCOL_VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 48;
pub const MAX_PAYLOAD_FLOATS: usize = 65_536; // 256 KiB
pub const MAX_PACKET_BYTES: usize = HEADER_SIZE + MAX_PAYLOAD_FLOATS * 4;

// ─── Command opcodes ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Cmd {
    Register    = 0x01,
    Heartbeat   = 0x02,
    ComputeTask = 0x03,
    Result      = 0x04,
    Failover    = 0x05,
    Ack         = 0x06,
    Deregister  = 0x07,
    Benchmark   = 0x08,
    Assign      = 0x09,
    Relay       = 0x0A,
    TokenOut    = 0x0B,
}

impl Cmd {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x01 => Some(Self::Register),
            0x02 => Some(Self::Heartbeat),
            0x03 => Some(Self::ComputeTask),
            0x04 => Some(Self::Result),
            0x05 => Some(Self::Failover),
            0x06 => Some(Self::Ack),
            0x07 => Some(Self::Deregister),
            0x08 => Some(Self::Benchmark),
            0x09 => Some(Self::Assign),
            0x0A => Some(Self::Relay),
            0x0B => Some(Self::TokenOut),
            _ => None,
        }
    }
}

// ─── Flags ─────────────────────────────────────────────────────────────────

pub mod flag {
    pub const NONE: u16   = 0;
    pub const SHADOW: u16 = 1 << 0;
    pub const FINAL: u16  = 1 << 1;
    pub const URGENT: u16 = 1 << 2;
}

// ─── Packet header (decoded view) ──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PacketHeader {
    pub command: Cmd,
    pub flags: u16,
    pub tx_id: u64,
    pub node_id: u64,
    pub cluster_id: u32,
    pub payload_len: u32,
    pub timestamp_us: u64,
    pub expected_us: u32,
    pub seq: u32,
}

// ─── Encode / Decode ───────────────────────────────────────────────────────

/// Decode a 48-byte header from a byte slice.
/// Returns `None` if magic/version mismatch or truncated.
pub fn decode_header(buf: &[u8]) -> Option<PacketHeader> {
    if buf.len() < HEADER_SIZE {
        return None;
    }
    let mut rdr = Cursor::new(&buf[..HEADER_SIZE]);

    let magic = rdr.read_u32::<BigEndian>().ok()?;
    if magic != MAGIC {
        return None;
    }
    let version = rdr.read_u8().ok()?;
    if version != PROTOCOL_VERSION {
        return None;
    }

    let cmd = Cmd::from_u8(rdr.read_u8().ok()?)?;
    let flags = rdr.read_u16::<LittleEndian>().ok()?;
    let tx_id = rdr.read_u64::<LittleEndian>().ok()?;
    let node_id = rdr.read_u64::<LittleEndian>().ok()?;
    let cluster_id = rdr.read_u32::<LittleEndian>().ok()?;
    let payload_len = rdr.read_u32::<LittleEndian>().ok()?;
    let timestamp_us = rdr.read_u64::<LittleEndian>().ok()?;
    let expected_us = rdr.read_u32::<LittleEndian>().ok()?;
    let seq = rdr.read_u32::<LittleEndian>().ok()?;

    Some(PacketHeader {
        command: cmd,
        flags,
        tx_id,
        node_id,
        cluster_id,
        payload_len,
        timestamp_us,
        expected_us,
        seq,
    })
}

/// Encode a header + optional payload into a pre-allocated buffer.
/// Returns the total byte length written, or `None` if the buffer is too small.
///
/// ## Safety contract for the caller
/// - `buf` must be at least `HEADER_SIZE + payload.len() * 4` bytes.
/// - Payload (if any) is copied into `buf[HEADER_SIZE..]`.
pub fn encode_packet(
    buf: &mut [u8],
    header: &PacketHeader,
    payload: Option<&[f32]>,
) -> Option<usize> {
    let payload_bytes = payload.map(|p| p.len() * 4).unwrap_or(0);
    let total = HEADER_SIZE + payload_bytes;
    if buf.len() < total {
        return None;
    }

    let mut wtr = Cursor::new(&mut buf[..]);
    wtr.write_u32::<BigEndian>(MAGIC).ok()?;
    wtr.write_u8(PROTOCOL_VERSION).ok()?;
    wtr.write_u8(header.command as u8).ok()?;
    wtr.write_u16::<LittleEndian>(header.flags).ok()?;
    wtr.write_u64::<LittleEndian>(header.tx_id).ok()?;
    wtr.write_u64::<LittleEndian>(header.node_id).ok()?;
    wtr.write_u32::<LittleEndian>(header.cluster_id).ok()?;
    wtr.write_u32::<LittleEndian>(payload_bytes as u32).ok()?;
    wtr.write_u64::<LittleEndian>(header.timestamp_us).ok()?;
    wtr.write_u32::<LittleEndian>(header.expected_us).ok()?;
    wtr.write_u32::<LittleEndian>(header.seq).ok()?;

    if let Some(floats) = payload {
        let payload_u8 = bytemuck::cast_slice(floats);
        buf[HEADER_SIZE..HEADER_SIZE + payload_u8.len()].copy_from_slice(payload_u8);
    }

    Some(total)
}

/// Return a `&[f32]` view over the payload region of a valid packet.
/// The caller must have already validated the header via `decode_header`.
pub fn payload_as_floats(buf: &[u8], payload_len: u32) -> &[f32] {
    let byte_len = payload_len as usize;
    if buf.len() < HEADER_SIZE + byte_len {
        return &[];
    }
    bytemuck::cast_slice(&buf[HEADER_SIZE..HEADER_SIZE + byte_len])
}

/// Build a minimal header for sending commands from this kernel.
pub fn make_header(
    command: Cmd,
    node_id: u64,
    cluster_id: u32,
    payload_floats: usize,
) -> PacketHeader {
    PacketHeader {
        command,
        flags: flag::NONE,
        tx_id: 0,
        node_id,
        cluster_id,
        payload_len: (payload_floats * 4) as u32,
        timestamp_us: 0,
        expected_us: 0,
        seq: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_header() {
        let hdr = PacketHeader {
            command: Cmd::ComputeTask,
            flags: flag::SHADOW,
            tx_id: 0xDEAD_BEEF,
            node_id: 0xCAFE_BABE,
            cluster_id: 10,
            payload_len: 16,
            timestamp_us: 123456789,
            expected_us: 5000,
            seq: 42,
        };

        let mut buf = vec![0u8; HEADER_SIZE + 16];
        let payload: Vec<f32> = vec![1.0, 2.0, 3.0, 4.0];
        let written = encode_packet(&mut buf, &hdr, Some(&payload)).unwrap();
        assert_eq!(written, HEADER_SIZE + 16);

        let decoded = decode_header(&buf).unwrap();
        assert_eq!(decoded.command, Cmd::ComputeTask);
        assert_eq!(decoded.flags, flag::SHADOW);
        assert_eq!(decoded.tx_id, 0xDEAD_BEEF);
        assert_eq!(decoded.payload_len, 16);

        let floats = payload_as_floats(&buf, decoded.payload_len);
        assert_eq!(floats, &[1.0, 2.0, 3.0, 4.0]);
    }
}
