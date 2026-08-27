//! QUIC transport layer — P2P binary tensor relay.
//!
//! Each kernel instance opens a long-lived QUIC connection to the master
//! orchestrator.  The QUIC stream carries the same 48-byte header + f32[]
//! payload as defined in `protocol.rs`.  QUIC's built-in 0-RTT and
//! multiplexed streams eliminate TCP head-of-line blocking.
//!
//! ## MTU-optimised framing
//!
//! We set the max datagram size to match the local Ethernet MTU (1500 bytes)
//! minus QUIC/UDP/IP headers (~100 bytes) → ~1400 bytes per frame.
//! This avoids IP fragmentation and keeps GPU-bound tensors contiguous.

#[cfg(feature = "quic")]
pub mod quic_stream;
pub mod tcp_stream;

use std::net::SocketAddr;

// ─── Network error ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("connection refused: {0}")]
    ConnectionRefused(String),
    #[error("connection closed")]
    ConnectionClosed,
    #[error("timeout")]
    Timeout,
    #[error("protocol: {0}")]
    Protocol(String),
    #[cfg(feature = "quic")]
    #[error("quic: {0}")]
    Quic(#[from] quinn::ConnectionError),
    #[cfg(feature = "quic")]
    #[error("quic stream write: {0}")]
    QuicWrite(#[from] quinn::WriteError),
    #[cfg(feature = "quic")]
    #[error("quic stream read: {0}")]
    QuicRead(#[from] quinn::ReadExactError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

// ─── Transport trait (swappable QUIC / TCP) ────────────────────────────────

/// Abstraction over the underlying transport so the kernel can use QUIC
/// in production and TCP for debugging / legacy devices.
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// Connect to a remote Akasha peer.
    async fn connect(&mut self, addr: SocketAddr) -> Result<(), NetError>;

    /// Send a raw binary frame (header + payload).
    async fn send(&mut self, frame: &[u8]) -> Result<(), NetError>;

    /// Receive a raw binary frame into the provided buffer.
    /// Returns the number of bytes read.
    async fn recv(&mut self, buf: &mut [u8]) -> Result<usize, NetError>;

    /// Close the connection gracefully.
    async fn close(&mut self) -> Result<(), NetError>;

    /// Whether the connection is still alive.
    fn is_connected(&self) -> bool;
}

// ─── Frame size helper ─────────────────────────────────────────────────────

/// Compute the optimal frame payload size for the local MTU.
/// Ethernet MTU 1500 − IP(20) − UDP(8) − QUIC header(~50) ≈ 1420.
/// We round down to a multiple of 4 for f32 alignment.
pub const fn mtu_payload_floats() -> usize {
    (1400usize / 4) // 350 f32s = 1400 bytes
}

/// Maximum number of f32s that fit in a single QUIC datagram without
/// IP fragmentation.
pub const MAX_DATAGRAM_FLOATS: usize = 350;

/// Given a total number of floats to send, return how many frames
/// (datagrams) it will be split into.
pub const fn frame_count(total_floats: usize) -> usize {
    (total_floats + MAX_DATAGRAM_FLOATS - 1) / MAX_DATAGRAM_FLOATS
}
