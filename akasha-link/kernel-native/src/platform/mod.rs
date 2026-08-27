//! Platform abstraction layer.
//!
//! Each target OS provides a different mechanism to keep the kernel alive
//! while the screen is off.  This module exposes a uniform `PlatformService`
//! trait that each platform implements.

// ─── Platform service trait ────────────────────────────────────────────────

/// OS-level lifecycle management for long-running AI inference.
///
/// Implementations:
/// - Android: Foreground Service with persistent notification
/// - iOS: BGTaskScheduler + extended background execution
/// - Desktop: no-op (process runs as a normal daemon)
#[async_trait::async_trait]
pub trait PlatformService: Send + Sync {
    /// Acquire a wakelock / start foreground service.
    /// Must be called before the inference loop starts.
    async fn acquire_wakelock(&self, reason: &str) -> Result<(), String>;

    /// Release the wakelock / stop foreground service.
    async fn release_wakelock(&self) -> Result<(), String>;

    /// Report inference progress to the OS (keeps the service alive).
    /// Called once per token produced.
    fn heartbeat(&self);

    /// Platform name for logging.
    fn name(&self) -> &'static str;

    /// Whether the platform requires explicit wakelock management.
    fn requires_wakelock(&self) -> bool {
        true
    }
}

// ─── Platform detection + factory ──────────────────────────────────────────

/// Create the appropriate platform service for the current OS.
pub fn create_platform_service() -> Box<dyn PlatformService> {
    #[cfg(target_os = "android")]
    {
        Box::new(android::AndroidService::new())
    }
    #[cfg(target_os = "ios")]
    {
        Box::new(ios::IosService::new())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Box::new(desktop::DesktopService::new())
    }
}

// ─── Platform modules ──────────────────────────────────────────────────────

#[cfg(target_os = "android")]
pub mod android;

#[cfg(target_os = "ios")]
pub mod ios;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod desktop;
