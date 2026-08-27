//! iOS platform service — Background Task + extended execution.
//!
//! ## Strategy
//!
//! iOS is extremely restrictive about background CPU/GPU work.
//! The recommended approach uses:
//!
//! 1. **BGTaskScheduler** — register a `BGProcessingTask` that requests
//!    periodic execution windows (~30 seconds every few minutes).
//! 2. **beginBackgroundTask** — when the app is active in foreground,
//!    request extended background time (up to 30s on modern iOS, ~3min
//!    if the system is not under memory pressure).
//! 3. **Silent push notifications** — the master can wake the app via
//!    APNs silent push when new inference work is available.
//!
//! ## Integration
//!
//! The Rust library is compiled as a static library (`.a`) and linked into
//! a Swift wrapper:
//!
//! ```swift
//! import BackgroundTasks
//!
//! class AkashaBackgroundTask {
//!     func schedule() {
//!         BGTaskScheduler.shared.register(
//!             forTaskWithIdentifier: "com.akasha.inference",
//!             using: nil
//!         ) { task in
//!             akasha_kernel_start_inference()
//!             task.setTaskCompleted(success: true)
//!         }
//!     }
//! }
//! ```
//!
//! The C FFI functions below are called from Swift.

use super::PlatformService;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct IosService {
    active: AtomicBool,
    /// Background task identifier (UIBackgroundTaskIdentifier).
    /// We track it so we can call `endBackgroundTask` on shutdown.
    bg_task_id: std::sync::Mutex<u64>,
}

impl IosService {
    pub fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
            bg_task_id: std::sync::Mutex::new(0),
        }
    }
}

#[async_trait::async_trait]
impl PlatformService for IosService {
    async fn acquire_wakelock(&self, reason: &str) -> Result<(), String> {
        log::info!("[ios] background task acquired: {reason}");
        self.active.store(true, Ordering::Release);

        // In production, this calls `UIApplication.shared.beginBackgroundTask`
        // via the C FFI bridge.
        // The returned task identifier is stored in `bg_task_id`.
        Ok(())
    }

    async fn release_wakelock(&self) -> Result<(), String> {
        log::info!("[ios] background task released");
        self.active.store(false, Ordering::Release);

        // End the background task if one is active
        let mut id = self.bg_task_id.lock().unwrap();
        if *id != 0 {
            // C FFI: akasha_ios_end_background_task(*id)
            *id = 0;
        }
        Ok(())
    }

    fn heartbeat(&self) {
        // On iOS, heartbeating is not required during the background
        // task window.  The task will expire on its own.
    }

    fn name(&self) -> &'static str {
        "ios-background"
    }
}

// ─── C FFI exports (called from Swift) ─────────────────────────────────────

/// Called from Swift when the app receives a background processing task.
#[no_mangle]
pub extern "C" fn akasha_kernel_start_inference() {
    log::info!("[ios-ffi] inference start requested");
}

/// Called from Swift when the background task is about to expire.
/// The kernel must checkpoint its state within ~5 seconds.
#[no_mangle]
pub extern "C" fn akasha_kernel_will_expire() {
    log::warn!("[ios-ffi] background task expiring — checkpointing...");
    // In production: save inference state to disk, close GPU handles gracefully.
}
