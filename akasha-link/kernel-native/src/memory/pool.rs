//! Static memory pool — zero heap allocation on the inference hot path.
//!
//! ## Design
//!
//! At kernel startup, a single contiguous `Box<[f32]>` is allocated for the
//! model's hidden-state buffers.  During the inference loop, incoming tensors
//! are written **in-place** into pre-assigned pool slots; no `Vec::push`,
//! no `Box::new`, no `Arc::clone` ever touches the hot path.
//!
//! ## Layout
//!
//! ```text
//! pool_memory: [slot_0 | slot_1 | ... | slot_N-1 | scratch_area]
//!               ←──  hidden_size × num_slots  ──→← scratch →
//! ```
//!
//! Each slot is `hidden_size` floats.  Slots are tracked by a free-list
//! bitmap (u64 bitmask) for O(1) acquire/release.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicU64, Ordering};

/// A pre-allocated pool of `[f32]` buffers for zero-allocation tensor ops.
///
/// ## Safety
///
/// The pool uses `UnsafeCell` for interior mutability.  Each slot is
/// logically owned by the thread that acquired it via `acquire()`.
/// The caller must ensure:
/// - No two threads hold the same slot simultaneously.
/// - `slot_mut()` is called only on a slot owned by the caller.
pub struct TensorPool {
    /// Contiguous memory: `hidden_size * max_slots` floats.
    /// Wrapped in `UnsafeCell` to allow mutable slot access through `&self`.
    memory: UnsafeCell<Box<[f32]>>,
    /// Size of each slot in floats.
    hidden_size: usize,
    /// Max concurrent slots.
    max_slots: usize,
    /// Bitmap free-list: bit i == 1 → slot i is free.
    free_bitmap: AtomicU64,
    /// Scratch area size (floats), located after all slots.
    scratch_size: usize,
}

impl TensorPool {
    /// Allocate the pool.
    ///
    /// # Panics
    /// Panics if `max_slots > 64` (bitmap is u64) or `hidden_size == 0`.
    pub fn new(hidden_size: usize, max_slots: usize, scratch_size: usize) -> Self {
        assert!(hidden_size > 0, "hidden_size must be > 0");
        assert!(max_slots <= 64, "max_slots must be ≤ 64 (u64 bitmap)");
        assert!(max_slots > 0, "max_slots must be > 0");

        let total = hidden_size * max_slots + scratch_size;
        let memory = vec![0.0f32; total].into_boxed_slice();

        // All slots initially free
        let free_bitmap = AtomicU64::new((1u64 << max_slots) - 1);

        Self {
            memory: UnsafeCell::new(memory),
            hidden_size,
            max_slots,
            free_bitmap,
            scratch_size,
        }
    }

    /// Acquire a slot. Returns the slot index (0..max_slots-1) or `None` if full.
    ///
    /// O(1) via atomic bit-scan.
    pub fn acquire(&self) -> Option<usize> {
        loop {
            let bitmap = self.free_bitmap.load(Ordering::Acquire);
            if bitmap == 0 {
                return None; // pool exhausted
            }
            // Find lowest set bit
            let slot = bitmap.trailing_zeros() as usize;
            let new_bitmap = bitmap & !(1u64 << slot);
            if self
                .free_bitmap
                .compare_exchange(bitmap, new_bitmap, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                // Zero the slot before handing it out
                unsafe {
                    let mem = &mut *self.memory.get();
                    let start = slot * self.hidden_size;
                    mem[start..start + self.hidden_size].fill(0.0);
                }
                return Some(slot);
            }
            // CAS failed — another thread grabbed it; retry
        }
    }

    /// Release a slot back to the pool.
    ///
    /// O(1) atomic bit-set.
    pub fn release(&self, slot: usize) {
        assert!(slot < self.max_slots, "slot out of range");
        let mask = 1u64 << slot;
        self.free_bitmap.fetch_or(mask, Ordering::Release);
    }

    /// Get a mutable slice reference to a slot's memory.
    ///
    /// # Safety
    /// The caller must ensure no other thread holds a reference to this slot.
    /// Each slot is logically owned by the thread that acquired it.
    pub fn slot_mut(&self, slot: usize) -> &mut [f32] {
        assert!(slot < self.max_slots, "slot out of range");
        let start = slot * self.hidden_size;
        unsafe {
            let mem = &mut *self.memory.get();
            &mut mem[start..start + self.hidden_size]
        }
    }

    /// Get a shared slice reference to a slot's memory (read-only).
    pub fn slot(&self, slot: usize) -> &[f32] {
        assert!(slot < self.max_slots, "slot out of range");
        let start = slot * self.hidden_size;
        unsafe {
            let mem = &*self.memory.get();
            &mem[start..start + self.hidden_size]
        }
    }

    /// Get the scratch area as a mutable slice.
    /// Located after all slots: `memory[hidden_size * max_slots ..]`.
    ///
    /// # Safety
    /// Caller must ensure exclusive access to the scratch area.
    pub fn scratch_mut(&self) -> &mut [f32] {
        let offset = self.hidden_size * self.max_slots;
        let len = self.scratch_size;
        unsafe {
            let mem = &mut *self.memory.get();
            &mut mem[offset..offset + len]
        }
    }

    /// Overwrite a slot with data from an external `&[f32]`.
    /// This is the hot-path operation: network recv → copy into pool → GPU bind.
    pub fn write_slot(&self, slot: usize, data: &[f32]) {
        let dest = self.slot_mut(slot);
        let n = dest.len().min(data.len());
        // SAFETY: both slices are valid f32; we're copying bytes.
        dest[..n].copy_from_slice(&data[..n]);
    }

    // ─── Accessors ───────────────────────────────────────────────────────

    pub fn hidden_size(&self) -> usize {
        self.hidden_size
    }

    pub fn max_slots(&self) -> usize {
        self.max_slots
    }

    pub fn available(&self) -> u32 {
        self.free_bitmap.load(Ordering::Relaxed).count_ones()
    }

    /// Total memory footprint in bytes.
    pub fn memory_bytes(&self) -> usize {
        unsafe {
            let mem = &*self.memory.get();
            mem.len() * 4
        }
    }
}

// SAFETY: TensorPool uses `UnsafeCell` for memory + AtomicU64 for slot
//          tracking.  Each slot is acquired/released atomically and
//          access is single-threaded per slot.
unsafe impl Send for TensorPool {}
unsafe impl Sync for TensorPool {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_release() {
        let pool = TensorPool::new(256, 4, 64);
        assert_eq!(pool.available(), 4);

        let s0 = pool.acquire().unwrap();
        let s1 = pool.acquire().unwrap();
        assert_eq!(pool.available(), 2);

        pool.release(s0);
        assert_eq!(pool.available(), 3);
        pool.release(s1);
        assert_eq!(pool.available(), 4);
    }

    #[test]
    fn write_and_read() {
        let pool = TensorPool::new(128, 4, 0);
        let s = pool.acquire().unwrap();
        let data: Vec<f32> = (0..128).map(|i| i as f32).collect();
        pool.write_slot(s, &data);
        assert_eq!(pool.slot(s), &data[..]);
    }
}
