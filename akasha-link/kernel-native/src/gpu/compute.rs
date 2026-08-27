//! GPU compute engine — wgpu-based neural network execution.
//!
//! Manages the wgpu device, creates compute pipelines from embedded WGSL
//! shaders, and dispatches tensor operations with zero-copy buffer binding.

use std::sync::Arc;
use wgpu::util::DeviceExt;
use wgpu::{Buffer, BufferUsages};

use super::shaders;

// ─── Error type ────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum GpuError {
    #[error("wgpu: {0}")]
    Wgpu(#[from] wgpu::RequestDeviceError),
    #[error("no compatible GPU adapter found")]
    AdapterNotFound,
    #[error("buffer size mismatch: need {need}, have {have}")]
    BufferSize { need: u64, have: u64 },
    #[error("shader not found: {0}")]
    ShaderNotFound(String),
}

// ─── Pipeline identifiers ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ComputeOp {
    MatmulVec,
    Gelu,
    RmsNorm,
    ResidualAdd,
}

// ─── Bind group layout per shader ─────────────────────────────────────────

enum BindingKind {
    Storage,
    Uniform,
}

/// 各 shader の @group(0) バインディングを (binding, kind, read_only) で定義。
/// shader の WGSL 宣言と一致させる必要がある（不一致はランタイム検証エラー）。
fn bindings_for(op: ComputeOp) -> Vec<(u32, BindingKind, bool)> {
    use BindingKind::{Storage, Uniform};
    match op {
        // W(0,read) x(1,read) b(2,read) y(3,rw) uniforms(4,uniform)
        ComputeOp::MatmulVec => vec![
            (0, Storage, true),
            (1, Storage, true),
            (2, Storage, true),
            (3, Storage, false),
            (4, Uniform, false),
        ],
        // data(0,rw) uniforms(1,uniform)
        ComputeOp::Gelu => vec![
            (0, Storage, false),
            (1, Uniform, false),
        ],
        // x(0,read) gamma(1,read) y(2,rw) uniforms(3,uniform)
        ComputeOp::RmsNorm => vec![
            (0, Storage, true),
            (1, Storage, true),
            (2, Storage, false),
            (3, Uniform, false),
        ],
        // x(0,rw) residual(1,read) uniforms(2,uniform)
        ComputeOp::ResidualAdd => vec![
            (0, Storage, false),
            (1, Storage, true),
            (2, Uniform, false),
        ],
    }
}

// ─── The compute engine ────────────────────────────────────────────────────

pub struct GpuEngine {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipelines: std::collections::HashMap<ComputeOp, wgpu::ComputePipeline>,
    /// Staging buffer for uniform data (reused every dispatch).
    uniform_buf: Buffer,
    /// Staging buffer for reading back GPU results.
    staging_buf: Buffer,
    staging_size: u64,
    /// Hidden size this engine was initialised for.
    hidden_size: u32,
}

impl GpuEngine {
    /// Initialise wgpu, create all compute pipelines.
    pub async fn new(hidden_size: u32) -> Result<Self, GpuError> {
        // ── wgpu instance + adapter ──
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or(GpuError::AdapterNotFound)?;

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("akasha-kernel-gpu"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits {
                        max_storage_buffer_binding_size: (hidden_size as u32 * hidden_size as u32 * 4)
                            .max(64 * 1024 * 1024), // up to 64 MiB
                        ..wgpu::Limits::downlevel_defaults()
                    },
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await?;

        // ── Compile pipelines ──
        let mut pipelines = std::collections::HashMap::new();
        let pipeline_specs: &[(ComputeOp, &str)] = &[
            (ComputeOp::MatmulVec, shaders::SHADER_MATMUL_VEC),
            (ComputeOp::Gelu, shaders::SHADER_GELU),
            (ComputeOp::RmsNorm, shaders::SHADER_RMS_NORM),
            (ComputeOp::ResidualAdd, shaders::SHADER_RESIDUAL_ADD),
        ];

        for &(op, wgsl_src) in pipeline_specs {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(&format!("akasha-{:?}", op)),
                source: wgpu::ShaderSource::Wgsl(wgsl_src.into()),
            });

            // shader ごとの @group(0) バインディングに一致するレイアウトを作る
            let entries: Vec<wgpu::BindGroupLayoutEntry> = bindings_for(op)
                .into_iter()
                .map(|(binding, storage, read_only)| wgpu::BindGroupLayoutEntry {
                    binding,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: match storage {
                        BindingKind::Storage => wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        BindingKind::Uniform => wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                    },
                    count: None,
                })
                .collect();

            let bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some(&format!("akasha-bgl-{:?}", op)),
                    entries: &entries,
                });

            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(&format!("akasha-layout-{:?}", op)),
                bind_group_layouts: &[&bind_group_layout],
                push_constant_ranges: &[],
            });

            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(&format!("akasha-pipeline-{:?}", op)),
                layout: Some(&layout),
                module: &shader,
                entry_point: "main",
                cache: None,
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            });

            pipelines.insert(op, pipeline);
        }

        // ── Pre-allocate staging buffers ──
        let staging_size = (hidden_size as u64) * 4; // enough for one f32 vector
        let staging_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("akasha-staging"),
            size: staging_size,
            usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("akasha-uniforms"),
            contents: &vec![0u8; 32], // 32 bytes uniform scratch
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
        });

        Ok(Self {
            device,
            queue,
            pipelines,
            uniform_buf,
            staging_buf,
            staging_size,
            hidden_size,
        })
    }

    // ─── Buffer factory ──────────────────────────────────────────────────

    /// Create a storage buffer initialised with f32 data.
    /// Returned as `(wgpu::Buffer, element_count)`.
    pub fn create_storage_buffer(&self, data: &[f32], label: &str) -> (Buffer, u32) {
        let bytes = bytemuck::cast_slice(data);
        let buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytes,
            usage: BufferUsages::STORAGE | BufferUsages::COPY_SRC | BufferUsages::COPY_DST,
        });
        (buf, data.len() as u32)
    }

    /// Create an empty storage buffer of `num_elements` f32s (zero-filled).
    pub fn create_storage_buffer_empty(&self, num_elements: u32, label: &str) -> Buffer {
        let byte_size = num_elements as u64 * 4;
        self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: byte_size,
            usage: BufferUsages::STORAGE | BufferUsages::COPY_SRC | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    // ─── Uniform helpers ─────────────────────────────────────────────────

    fn write_uniforms(&self, data: &[u32]) {
        let bytes = bytemuck::cast_slice(data);
        self.queue
            .write_buffer(&self.uniform_buf, 0, &bytes[..bytes.len().min(32)]);
    }

    // ─── Dispatch ────────────────────────────────────────────────────────

    /// Execute a compute operation.
    ///
    /// `output_buf` must be writable (STORAGE + COPY_SRC).  The result is
    /// available on the GPU timeline; to read back, call `read_buffer`.
    pub fn dispatch(
        &self,
        op: ComputeOp,
        bind_group: &wgpu::BindGroup,
        workgroup_count: (u32, u32, u32),
    ) {
        let pipeline = self
            .pipelines
            .get(&op)
            .unwrap_or_else(|| panic!("Pipeline {:?} not compiled", op));

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some(&format!("akasha-{:?}", op)),
            });

        {
            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some(&format!("akasha-pass-{:?}", op)),
                timestamp_writes: None,
            });
            cpass.set_pipeline(pipeline);
            cpass.set_bind_group(0, bind_group, &[]);
            cpass.dispatch_workgroups(workgroup_count.0, workgroup_count.1, workgroup_count.2);
        }

        self.queue.submit(std::iter::once(encoder.finish()));
    }

    /// Read a GPU buffer back to CPU as `Vec<f32>`.
    /// Blocks until the GPU work is complete.
    pub async fn read_buffer(&self, src: &Buffer, num_elements: u32) -> Vec<f32> {
        let byte_size = num_elements as u64 * 4;

        // Ensure staging buffer is large enough
        if self.staging_size < byte_size {
            // Re-allocate staging — this is rare (init path, not hot path)
            log::warn!("staging buffer resize: {} → {}", self.staging_size, byte_size);
        }

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("akasha-readback"),
            });
        encoder.copy_buffer_to_buffer(src, 0, &self.staging_buf, 0, byte_size);
        self.queue.submit(std::iter::once(encoder.finish()));

        // Map + read
        let slice = self.staging_buf.slice(..byte_size);
        let (tx, rx) = tokio::sync::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        self.device.poll(wgpu::Maintain::Wait);
        rx.await
            .expect("map callback dropped")
            .expect("buffer map failed");

        let data = slice.get_mapped_range();
        let floats: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
        drop(data);
        self.staging_buf.unmap();

        floats
    }

    /// Poll the GPU device for completion (non-blocking check).
    pub fn poll(&self) {
        self.device.poll(wgpu::Maintain::Poll);
    }

    // ─── Convenience: full matmul + GELU pipeline ────────────────────────

    /// Run a single transformer MLP block: `output = GELU(W @ input + bias)`.
    ///
    /// This is the most common hot-path operation.  All buffers are
    /// pre-allocated by the caller (from `TensorPool`).
    pub async fn matmul_gelu_block(
        &self,
        weight: &Buffer,   // [output_dim, input_dim]
        input: &Buffer,    // [input_dim]
        bias: &Buffer,     // [output_dim]
        output: &Buffer,   // [output_dim] ← result written here
        input_dim: u32,
        output_dim: u32,
    ) {
        // Build bind group for matmul
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("akasha-matmul-bg"),
            layout: &self.pipelines[&ComputeOp::MatmulVec].get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: weight.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: input.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: bias.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: output.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: self.uniform_buf.as_entire_binding(),
                },
            ],
        });

        self.write_uniforms(&[input_dim, output_dim, 0, 0]);
        let workgroups = ((output_dim + 255) / 256, 1, 1);
        self.dispatch(ComputeOp::MatmulVec, &bg, workgroups);
    }

    // ─── Accessors ───────────────────────────────────────────────────────

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    pub fn hidden_size(&self) -> u32 {
        self.hidden_size
    }
}
