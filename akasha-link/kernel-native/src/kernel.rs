//! Akasha Kernel — main integration module.
//!
//! Wires together memory pool, GPU engine, network transport, and platform
//! service into the unified inference loop.

use crate::gpu::{ComputeOp, GpuEngine};
use crate::memory::pool::TensorPool;
use crate::net::Transport;
use crate::platform::PlatformService;
use crate::protocol::{self, Cmd, PacketHeader};

/// Akasha Kernel configuration.
pub struct KernelConfig {
    /// Model hidden size (e.g., 2048 for Gemma-2B, 4096 for Llama-7B).
    pub hidden_size: u32,
    /// Number of transformer layers assigned to this kernel.
    pub num_layers: u32,
    /// Master orchestrator address.
    pub master_addr: std::net::SocketAddr,
    /// This kernel's node ID (assigned by the master during ASSIGN).
    pub node_id: u64,
    /// Cluster ID assigned by the master.
    pub cluster_id: u32,
    /// Maximum concurrent tensor slots in the memory pool.
    pub max_tensor_slots: usize,
    /// Whether to use QUIC (true) or TCP (false).
    pub use_quic: bool,
}

/// The running kernel instance.
pub struct AkashaKernel {
    config: KernelConfig,
    gpu: GpuEngine,
    pool: TensorPool,
    platform: Box<dyn PlatformService>,
    /// Transport is dynamic to allow QUIC/TCP selection at runtime.
    transport: Box<dyn Transport>,
}

impl AkashaKernel {
    /// Initialise the kernel: allocate GPU context, memory pool, connect transport.
    pub async fn new(config: KernelConfig) -> Result<Self, String> {
        log::info!(
            "Akasha-Kernel v{} initialising (node={:#x}, hidden={}, layers={})",
            env!("CARGO_PKG_VERSION"),
            config.node_id,
            config.hidden_size,
            config.num_layers,
        );

        // ── GPU ──
        let gpu = GpuEngine::new(config.hidden_size)
            .await
            .map_err(|e| format!("GPU init failed: {e}"))?;

        // ── Memory pool ──
        // Slots: 2× (input + output) + scratch for intermediate activations
        let pool = TensorPool::new(
            config.hidden_size as usize,
            config.max_tensor_slots,
            config.hidden_size as usize * 2, // scratch: 2× hidden_size
        );
        log::info!(
            "Memory pool: {} MiB ({} slots × {} floats, {} scratch)",
            pool.memory_bytes() / (1024 * 1024),
            config.max_tensor_slots,
            config.hidden_size,
            config.hidden_size as usize * 2,
        );

        // ── Platform service ──
        let platform = crate::platform::create_platform_service();
        platform
            .acquire_wakelock("Akasha inference starting")
            .await
            .map_err(|e| format!("Platform wakelock failed: {e}"))?;

        // ── Transport ──
        let transport: Box<dyn Transport> = if config.use_quic {
            #[cfg(feature = "quic")]
            {
                Box::new(crate::net::quic_stream::QuicTransport::new())
            }
            #[cfg(not(feature = "quic"))]
            {
                return Err("QUIC feature not compiled".into());
            }
        } else {
            Box::new(crate::net::tcp_stream::TcpTransport::new())
        };

        Ok(Self {
            config,
            gpu,
            pool,
            platform,
            transport,
        })
    }

    /// Connect to the master orchestrator.
    pub async fn connect(&mut self) -> Result<(), String> {
        self.transport
            .connect(self.config.master_addr)
            .await
            .map_err(|e| format!("Transport connect failed: {e}"))?;
        Ok(())
    }

    /// Main inference loop — runs until the transport closes or an error occurs.
    ///
    /// Each iteration:
    /// 1. Receive a binary packet from the master (COMPUTE_TASK or RELAY).
    /// 2. Acquire a tensor pool slot.
    /// 3. Write the incoming activation into the slot (in-place, zero-copy).
    /// 4. Bind the slot to the GPU compute pipeline.
    /// 5. Execute the assigned transformer layers.
    /// 6. Send RESULT or RELAY back.
    /// 7. Release the slot.
    pub async fn run_loop(&mut self) -> Result<(), String> {
        log::info!("Inference loop started");

        // Allocate GPU buffers for model weights (placeholder — real weights
        // would be loaded from a GGUF/safetensors file at startup).
        let (weight_buf, _) = self.gpu.create_storage_buffer(
            &vec![0.0f32; (self.config.hidden_size * self.config.hidden_size) as usize],
            "weight",
        );
        let (bias_buf, _) = self.gpu.create_storage_buffer(
            &vec![0.0f32; self.config.hidden_size as usize],
            "bias",
        );

        let output_buf = self
            .gpu
            .create_storage_buffer_empty(self.config.hidden_size, "output");

        let mut token_count: u64 = 0;
        let start_time = std::time::Instant::now();

        loop {
            // ── Receive packet ──
            let mut recv_buf = vec![0u8; protocol::MAX_PACKET_BYTES];
            let n = self
                .transport
                .recv(&mut recv_buf)
                .await
                .map_err(|e| format!("recv error: {e}"))?;

            let header = protocol::decode_header(&recv_buf[..n])
                .ok_or("bad packet header")?;

            let payload = protocol::payload_as_floats(&recv_buf[..n], header.payload_len);

            // ── Handle command ──
            match header.command {
                Cmd::ComputeTask | Cmd::Relay => {
                    // Acquire a pool slot → write tensor in-place
                    let slot = self.pool.acquire().ok_or("tensor pool exhausted")?;
                    self.pool.write_slot(slot, payload);

                    // GPU inference: matmul + GELU (simplified; real impl chains
                    // all assigned layers).
                    self.gpu
                        .matmul_gelu_block(
                            &weight_buf,
                            // For simplicity, we use the output buffer as input
                            // (in a real impl, pool.slot(slot) would be uploaded
                            // to a GPU storage buffer first).
                            &output_buf,
                            &bias_buf,
                            &output_buf,
                            self.config.hidden_size,
                            self.config.hidden_size,
                        )
                        .await;

                    // Read back result
                    let _result = self
                        .gpu
                        .read_buffer(&output_buf, self.config.hidden_size)
                        .await;

                    // Release slot
                    self.pool.release(slot);

                    token_count += 1;
                    self.platform.heartbeat();

                    // ── Send RELAY (non-tail) or RESULT (tail) ──
                    // In a real multi-band setup, the kernel knows whether it's
                    // the tail band from the ASSIGN metadata.
                    // For now, always send a RESULT back.
                    let resp_header = protocol::make_header(
                        Cmd::Result,
                        self.config.node_id,
                        self.config.cluster_id,
                        self.config.hidden_size as usize,
                    );

                    let mut send_buf =
                        vec![0u8; protocol::HEADER_SIZE + self.config.hidden_size as usize * 4];
                    let _written = protocol::encode_packet(
                        &mut send_buf,
                        &resp_header,
                        Some(&_result),
                    )
                    .ok_or("encode failed")?;

                    self.transport
                        .send(&send_buf)
                        .await
                        .map_err(|e| format!("send error: {e}"))?;
                }
                Cmd::Heartbeat => {
                    // Respond with ACK
                    let ack = protocol::make_header(Cmd::Ack, self.config.node_id, 0, 0);
                    let mut buf = vec![0u8; protocol::HEADER_SIZE];
                    protocol::encode_packet(&mut buf, &ack, None);
                    let _ = self.transport.send(&buf).await;
                }
                Cmd::Assign => {
                    log::info!(
                        "Received ASSIGN: cluster={}, seq={}",
                        header.cluster_id,
                        header.seq,
                    );
                }
                _ => {
                    log::debug!("Unhandled command: {:?}", header.command);
                }
            }

            // Periodic stats
            if token_count % 100 == 0 {
                let elapsed = start_time.elapsed().as_secs_f64();
                let tps = token_count as f64 / elapsed.max(0.001);
                log::info!("Tokens: {token_count} | {tps:.1} tok/s | pool: {}/{} slots free",
                    self.pool.available(),
                    self.config.max_tensor_slots,
                );
            }
        }
    }

    /// Graceful shutdown.
    pub async fn shutdown(&mut self) {
        log::info!("Shutting down Akasha Kernel...");
        self.platform
            .release_wakelock()
            .await
            .unwrap_or_else(|e| log::error!("wakelock release failed: {e}"));
        let _ = self.transport.close().await;
        log::info!("Akasha Kernel stopped.");
    }
}
