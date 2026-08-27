//! Desktop platform service — no-op (process runs as a normal daemon).
//!
//! Linux / macOS: no wakelock needed.  The process stays alive as long
//! as the terminal or systemd unit is running.

use super::PlatformService;

pub struct DesktopService;

impl DesktopService {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl PlatformService for DesktopService {
    async fn acquire_wakelock(&self, _reason: &str) -> Result<(), String> {
        Ok(())
    }

    async fn release_wakelock(&self) -> Result<(), String> {
        Ok(())
    }

    fn heartbeat(&self) {
        // no-op on desktop
    }

    fn name(&self) -> &'static str {
        "desktop"
    }

    fn requires_wakelock(&self) -> bool {
        false
    }
}
