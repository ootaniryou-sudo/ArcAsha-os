//! Raw TCP transport — fallback when QUIC is unavailable.
//!
//! Used on platforms where QUIC library support is limited (older Android,
//! some embedded Linux builds).  Provides the same `Transport` trait
//! interface with a simple length-prefixed framing over a single TCP stream.

use super::{NetError, Transport};
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct TcpTransport {
    stream: Option<TcpStream>,
    connected: bool,
}

impl TcpTransport {
    pub fn new() -> Self {
        Self {
            stream: None,
            connected: false,
        }
    }
}

#[async_trait::async_trait]
impl Transport for TcpTransport {
    async fn connect(&mut self, addr: SocketAddr) -> Result<(), NetError> {
        let stream = TcpStream::connect(addr).await?;
        stream.set_nodelay(true)?; // disable Nagle — we want every frame out ASAP
        self.stream = Some(stream);
        self.connected = true;
        log::info!("TCP connected to {}", addr);
        Ok(())
    }

    async fn send(&mut self, frame: &[u8]) -> Result<(), NetError> {
        let stream = self.stream.as_ref().ok_or(NetError::ConnectionClosed)?;
        let len_prefix = (frame.len() as u32).to_le_bytes();
        stream.writable().await?;
        stream.try_write(&len_prefix)?;
        stream.try_write(frame)?;
        Ok(())
    }

    async fn recv(&mut self, buf: &mut [u8]) -> Result<usize, NetError> {
        let stream = self.stream.as_ref().ok_or(NetError::ConnectionClosed)?;
        let mut len_buf = [0u8; 4];
        stream.readable().await?;
        stream.try_read(&mut len_buf)?;
        let frame_len = u32::from_le_bytes(len_buf) as usize;
        if frame_len > buf.len() {
            return Err(NetError::Protocol(format!(
                "frame too large: {frame_len} > {}",
                buf.len()
            )));
        }
        stream.readable().await?;
        let n = stream.try_read(&mut buf[..frame_len])?;
        Ok(n)
    }

    async fn close(&mut self) -> Result<(), NetError> {
        self.connected = false;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }
}
