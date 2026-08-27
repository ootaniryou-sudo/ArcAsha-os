//! Akasha-Kernel — native edge AI runtime.
//!
//! This crate compiles to both:
//! - A static library (`.a` / `.so`) for Android/iOS embedding
//! - A standalone binary for Linux/macOS desktop testing
//!
//! ## Crate structure
//!
//! | Module       | Purpose                                      |
//! |-------------|----------------------------------------------|
//! | `protocol`  | 48-byte header binary codec (Rust)            |
//! | `memory`    | Static tensor pool — zero heap allocation     |
//! | `gpu`       | wgpu compute engine + WGSL shaders            |
//! | `net`       | QUIC / TCP transport (P2P tensor relay)       |
//! | `platform`  | OS lifecycle: Android foreground, iOS BG task |
//! | `kernel`    | Integration: ties all modules together        |

pub mod protocol;
pub mod memory;
pub mod gpu;
pub mod net;
pub mod platform;
pub mod kernel;

// Re-export key types for convenience
pub use kernel::{AkashaKernel, KernelConfig};
pub use memory::pool::TensorPool;
pub use gpu::{ComputeOp, GpuEngine, GpuError};
pub use protocol::{Cmd, PacketHeader, HEADER_SIZE, MAX_PACKET_BYTES};
pub use net::{Transport, NetError};
pub use platform::PlatformService;

// ─── C FFI exports (for Android JNI / iOS Swift bridging) ──────────────────

/// Initialise the kernel from C/FFI.
///
/// # Safety
/// `config_json` must be a valid UTF-8 C string pointing to a JSON
/// representation of `KernelConfig`.
#[no_mangle]
pub unsafe extern "C" fn akasha_kernel_init(
    config_json: *const std::ffi::c_char,
) -> *mut AkashaKernel {
    let c_str = unsafe { std::ffi::CStr::from_ptr(config_json) };
    let config_str = c_str.to_str().unwrap_or("{}");

    // Simple manual JSON parse (no serde dependency — keep it lean).
    // In production, use `serde_json` or a hand-rolled parser.
    let config = parse_kernel_config_from_json(config_str);

    // Spawn the kernel on the Tokio runtime.
    // The runtime is stored in a thread-local / global for FFI callers.
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let kernel = runtime.block_on(async {
        AkashaKernel::new(config).await.expect("kernel init")
    });

    Box::into_raw(Box::new(kernel))
}

/// Start the inference loop (blocking call from C/FFI).
///
/// # Safety
/// `kernel_ptr` must be a valid pointer returned by `akasha_kernel_init`.
#[no_mangle]
pub unsafe extern "C" fn akasha_kernel_run(kernel_ptr: *mut AkashaKernel) -> i32 {
    let kernel = unsafe { &mut *kernel_ptr };
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    match runtime.block_on(async {
        kernel.connect().await?;
        kernel.run_loop().await
    }) {
        Ok(()) => 0,
        Err(e) => {
            log::error!("kernel run failed: {e}");
            1
        }
    }
}

/// Shut down the kernel and free its memory.
///
/// # Safety
/// `kernel_ptr` must be a valid pointer returned by `akasha_kernel_init`.
#[no_mangle]
pub unsafe extern "C" fn akasha_kernel_shutdown(kernel_ptr: *mut AkashaKernel) {
    if kernel_ptr.is_null() {
        return;
    }
    let mut kernel = unsafe { Box::from_raw(kernel_ptr) };
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async { kernel.shutdown().await });
}

// ─── Minimal JSON config parser (no serde — keep it lean) ──────────────────

fn parse_kernel_config_from_json(json: &str) -> KernelConfig {
    // Extract fields with simple string scanning.
    // Production code would use `serde_json`; this is a zero-dependency fallback.
    let get_u64 = |key: &str| -> u64 {
        json.split(key)
            .nth(1)
            .and_then(|s| s.trim_start_matches(|c| c == ':' || c == '"' || c == ' ').split(',').next())
            .and_then(|s| s.trim().trim_matches('"').parse().ok())
            .unwrap_or(0)
    };
    let get_u32 = |key: &str| -> u32 {
        json.split(key)
            .nth(1)
            .and_then(|s| s.trim_start_matches(|c| c == ':' || c == '"' || c == ' ').split(',').next())
            .and_then(|s| s.trim().trim_matches('"').parse().ok())
            .unwrap_or(0)
    };
    let get_bool = |key: &str| -> bool {
        json.split(key)
            .nth(1)
            .and_then(|s| s.trim_start_matches(|c| c == ':' || c == '"' || c == ' ').split(',').next())
            .map(|s| s.trim() == "true")
            .unwrap_or(false)
    };

    let addr_str = json
        .split("\"master_addr\"")
        .nth(1)
        .and_then(|s| s.trim_start_matches(|c| c == ':' || c == '"' || c == ' ').split('"').nth(1))
        .unwrap_or("127.0.0.1:8080");
    let master_addr: std::net::SocketAddr = addr_str.parse().unwrap_or_else(|_| {
        "127.0.0.1:8080".parse().unwrap()
    });

    KernelConfig {
        hidden_size: get_u32("hidden_size").max(256),
        num_layers: get_u32("num_layers").max(1),
        master_addr,
        node_id: get_u64("node_id"),
        cluster_id: get_u32("cluster_id"),
        max_tensor_slots: get_u32("max_tensor_slots").max(4) as usize,
        use_quic: get_bool("use_quic"),
    }
}
