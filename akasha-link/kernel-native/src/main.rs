//! Akasha-Kernel — Native GPU-driven inference engine.
//!
//! Cross-platform (Android Vulkan / iOS Metal / Linux Vulkan / macOS Metal).
//! Direct GPU binding via wgpu, QUIC P2P relay with 36-byte extended header,
//! static pre-allocated memory pools (zero heap allocation on hot path).
//!
//! Usage:
//! ```bash
//! cargo run --release -- --master 192.168.1.100:8080 --node-id 0xCAFE --hidden-size 2048 --gpu
//! ```

use akasha_kernel::{AkashaKernel, KernelConfig};
use std::net::SocketAddr;
use std::time::Instant;

/// Fletcher-32 checksum (inline, no heap alloc).
/// Matches the TypeScript implementation in protocol.ts.
fn fletcher32(data: &[u8]) -> u32 {
    let mut sum1: u32 = 0xffff;
    let mut sum2: u32 = 0xffff;
    for &byte in data {
        sum1 = (sum1 + byte as u32) % 65535;
        sum2 = (sum2 + sum1) % 65535;
    }
    (sum2 << 16) | sum1
}

/// 36-byte extended header (matching TS protocol).
#[repr(C)]
struct ExtendedHeader {
    tx_id_lo: u64,
    tx_id_hi: u64,
    layer_id: u32,
    seq: u64,
    payload_len: u32,
    checksum: u32,
}

impl ExtendedHeader {
    fn decode(buf: &[u8]) -> Option<Self> {
        if buf.len() < 36 { return None; }
        Some(Self {
            tx_id_lo: u64::from_le_bytes(buf[0..8].try_into().ok()?),
            tx_id_hi: u64::from_le_bytes(buf[8..16].try_into().ok()?),
            layer_id: u32::from_le_bytes(buf[16..20].try_into().ok()?),
            seq: u64::from_le_bytes(buf[20..28].try_into().ok()?),
            payload_len: u32::from_le_bytes(buf[28..32].try_into().ok()?),
            checksum: u32::from_le_bytes(buf[32..36].try_into().ok()?),
        })
    }

    fn verify_payload(&self, payload: &[u8]) -> bool {
        fletcher32(payload) == self.checksum
    }
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args: Vec<String> = std::env::args().collect();
    let master_addr: SocketAddr = parse_arg(&args, "--master", "127.0.0.1:8080")
        .parse()
        .expect("invalid --master address");
    let node_id = parse_arg_u64(&args, "--node-id", 0xCAFE_BABE);
    let hidden_size = parse_arg_u32(&args, "--hidden-size", 2048);
    let num_layers = parse_arg_u32(&args, "--num-layers", 12);
    let use_quic = !args.contains(&"--tcp".to_string());
    let direct_gpu = args.contains(&"--gpu".to_string());

    // ── GPU backend detection ──────────────────────────────────────────

    if direct_gpu {
        log::info!(
            "GPU backend: {}",
            if cfg!(target_os = "android") { "Vulkan (Android)" }
            else if cfg!(target_os = "ios") { "Metal (iOS)" }
            else if cfg!(target_os = "macos") { "Metal (macOS)" }
            else { "Vulkan (Linux)" }
        );
    }

    let config = KernelConfig {
        hidden_size,
        num_layers,
        master_addr,
        node_id,
        cluster_id: 0,
        max_tensor_slots: if direct_gpu { 16 } else { 8 },
        use_quic,
    };

    // ── Static memory pool report ───────────────────────────────────────

    let pool_bytes = hidden_size as usize * config.max_tensor_slots * 4
        + hidden_size as usize * 2 * 4; // slots + scratch
    log::info!(
        "Akasha-Kernel v{} — node {:#x}",
        env!("CARGO_PKG_VERSION"),
        config.node_id,
    );
    log::info!(
        "  Model: {} layers × {}d  |  Transport: {}  |  GPU: {}",
        config.num_layers,
        config.hidden_size,
        if config.use_quic { "QUIC" } else { "TCP" },
        if direct_gpu { "direct (Vulkan/Metal)" } else { "CPU fallback" },
    );
    log::info!(
        "  Memory pool: {} KiB ({} slots + scratch) — ZERO heap alloc on hot path",
        pool_bytes / 1024,
        config.max_tensor_slots,
    );

    // ── Kernel init ────────────────────────────────────────────────────

    let start = Instant::now();
    let mut kernel = AkashaKernel::new(config)
        .await
        .expect("kernel initialisation failed");

    log::info!("  Init time: {}ms", start.elapsed().as_millis());

    if let Err(e) = kernel.connect().await {
        log::error!("Failed to connect: {e}");
        kernel.shutdown().await;
        std::process::exit(1);
    }

    log::info!("  Connected to master at {}", master_addr);

    // ── Background keep-alive (prevents OS task kill on mobile) ────────

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        log::info!("  Platform: mobile — foreground keep-alive active");
        // Android: ForegroundService is started by the Kotlin/Java wrapper
        // iOS: BGTaskScheduler is registered by the Swift wrapper
        // Rust side: periodic heartbeat keeps the process alive
        let node_id_copy = node_id;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;
                log::debug!("  heartbeat: node {:#x} alive", node_id_copy);
            }
        });
    }

    // ── Graceful shutdown ──────────────────────────────────────────────

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
    let mut kernel_shutdown = Some(kernel);

    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        let _ = tx.send(()).await;
    });

    let loop_start = Instant::now();
    let result = tokio::select! {
        result = kernel_shutdown.as_mut().unwrap().run_loop() => {
            result
        }
        _ = rx.recv() => {
            log::info!("Received shutdown signal");
            Ok(())
        }
    };

    let elapsed = loop_start.elapsed();
    log::info!(
        "Inference loop ran for {:.1}s",
        elapsed.as_secs_f64(),
    );

    if let Err(e) = result {
        log::error!("Inference loop error: {e}");
    }

    if let Some(mut k) = kernel_shutdown.take() {
        k.shutdown().await;
    }

    log::info!("Akasha-Kernel stopped.");
}

// ─── CLI helpers ───────────────────────────────────────────────────────────

fn parse_arg(args: &[String], flag: &str, default: &str) -> String {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| default.to_string())
}

fn parse_arg_u64(args: &[String], flag: &str, default: u64) -> u64 {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .and_then(|s| {
            if s.starts_with("0x") || s.starts_with("0X") {
                u64::from_str_radix(&s[2..], 16).ok()
            } else {
                s.parse().ok()
            }
        })
        .unwrap_or(default)
}

fn parse_arg_u32(args: &[String], flag: &str, default: u32) -> u32 {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}
