//! Android platform service — Foreground Service with persistent notification.
//!
//! ## Strategy
//!
//! On Android 8+, background services are aggressively killed within minutes.
//! The only reliable way to keep the GPU warm is a **foreground service**
//! with an ongoing notification visible to the user.
//!
//! ## Integration
//!
//! The Rust library is loaded via JNI from a thin Kotlin/Java wrapper:
//!
//! ```kotlin
//! class AkashaForegroundService : Service() {
//!     override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
//!         startForeground(NOTIFICATION_ID, buildNotification())
//!         // Call into Rust via JNI
//!         AkashaKernel.nativeStartInference()
//!         return START_STICKY
//!     }
//! }
//! ```
//!
//! This module provides the Rust-side hooks.  The actual `startForeground()`
//! call happens in Kotlin; Rust calls back via JNI to update the notification
//! text (e.g., "推論中... 3 tokens/秒").

use super::PlatformService;

pub struct AndroidService {
    // JNI VM reference (set once during initialisation)
    // In a real implementation this would hold a `JavaVM` and `JObject`
    // for the service instance to call back into Java.
    active: std::sync::atomic::AtomicBool,
}

impl AndroidService {
    pub fn new() -> Self {
        // In production, `AndroidService` receives a `JavaVM` pointer
        // from `JNI_OnLoad` and caches it for notification updates.
        Self {
            active: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Update the ongoing notification text (called from Rust).
    /// This would invoke `notificationManager.notify()` via JNI.
    #[allow(dead_code)]
    fn update_notification(&self, text: &str) {
        // JNI call: service.updateNotification(text)
        log::info!("[android-foreground] notification: {text}");
    }
}

#[async_trait::async_trait]
impl PlatformService for AndroidService {
    async fn acquire_wakelock(&self, reason: &str) -> Result<(), String> {
        log::info!("[android] foreground service acquired: {reason}");
        // In production:
        // 1. Call JNI to start the foreground service.
        // 2. Acquire a PARTIAL_WAKE_LOCK via PowerManager.
        // 3. Set the process priority to FOREGROUND.
        self.active.store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    async fn release_wakelock(&self) -> Result<(), String> {
        log::info!("[android] foreground service released");
        // JNI: stopForeground(STOP_FOREGROUND_REMOVE)
        self.active.store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    fn heartbeat(&self) {
        // Update the notification with current stats
        // This tells Android "we're still doing useful work"
        if self.active.load(std::sync::atomic::Ordering::Acquire) {
            self.update_notification("Akasha inference active...");
        }
    }

    fn name(&self) -> &'static str {
        "android-foreground"
    }
}

// ─── JNI exports (linked by the Kotlin wrapper) ────────────────────────────

/// JNI entry point: called from Kotlin `AkashaKernel.nativeStartInference()`.
///
/// ```kotlin
/// external fun nativeStartInference()
/// ```
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_akasha_kernel_AkashaKernel_nativeStartInference(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    log::info!("[jni] nativeStartInference called from Kotlin");

    // Spawn the inference loop on the Tokio runtime.
    // The runtime is initialised once in `main.rs` / `lib.rs`.
    // Here we'd send a signal to the running inference task.
}

/// JNI entry point: called from Kotlin `AkashaKernel.nativeStopInference()`.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_akasha_kernel_AkashaKernel_nativeStopInference(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    log::info!("[jni] nativeStopInference called from Kotlin");
}
