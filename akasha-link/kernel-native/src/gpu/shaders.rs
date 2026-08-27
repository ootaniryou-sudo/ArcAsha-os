//! GPU compute shaders (WGSL) embedded as compile-time constants.
//!
//! These shaders are compiled to SPIR-V at build time (via `wgpu::include_wgsl!`)
//! and dispatched by the compute engine.  Each shader corresponds to one
//! transformer block operation the edge device may be asked to run.

/// WGSL shader: matrix-vector multiply (y = Wx + b) — the core operation
/// of every transformer MLP and attention projection.
///
/// Workgroup: 256 threads.
/// `W`: [output_dim, input_dim] f32 (row-major)
/// `x`: [input_dim] f32
/// `b`: [output_dim] f32
/// `y`: [output_dim] f32  (output)
pub const SHADER_MATMUL_VEC: &str = r#"
@group(0) @binding(0) var<storage, read>  W: array<f32>;
@group(0) @binding(1) var<storage, read>  x: array<f32>;
@group(0) @binding(2) var<storage, read>  b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;

struct Uniforms {
    input_dim: u32,
    output_dim: u32,
}
@group(0) @binding(4) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let row = gid.x;
    if row >= uniforms.output_dim {
        return;
    }

    var sum: f32 = b[row];

    // Direct dot-product loop (256-wide workgroup → each thread handles 1 row)
    for (var col: u32 = 0u; col < uniforms.input_dim; col++) {
        sum += W[row * uniforms.input_dim + col] * x[col];
    }

    y[row] = sum;
}
"#;

/// WGSL shader: GELU activation (element-wise).
///
/// GELU(x) = 0.5 * x * (1 + tanh(sqrt(2/π) * (x + 0.044715 * x³)))
pub const SHADER_GELU: &str = r#"
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

struct Uniforms {
    num_elements: u32,
}
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if i >= uniforms.num_elements {
        return;
    }

    let x = data[i];
    let x3 = x * x * x;
    // Approximate GELU via tanh
    let inner = 0.7978845608 * (x + 0.044715 * x3); // sqrt(2/π) ≈ 0.79788
    let tanh_val = tanh(inner);
    data[i] = 0.5 * x * (1.0 + tanh_val);
}
"#;

/// WGSL shader: RMS Layer Normalization.
///
/// y = x / sqrt(mean(x²) + ε) * γ
pub const SHADER_RMS_NORM: &str = r#"
@group(0) @binding(0) var<storage, read>       x: array<f32>;
@group(0) @binding(1) var<storage, read>       gamma: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;

struct Uniforms {
    num_elements: u32,
    epsilon: f32,
}
@group(0) @binding(3) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if i >= uniforms.num_elements {
        return;
    }

    // Compute mean(x²) in a single thread per element... simplified version.
    // A production shader would use workgroup-level reduction via
    // subgroup operations or shared memory.  This is the readable version.
    var sum_sq: f32 = 0.0;
    for (var j: u32 = 0u; j < uniforms.num_elements; j++) {
        sum_sq += x[j] * x[j];
    }
    let rms = sqrt(sum_sq / f32(uniforms.num_elements) + uniforms.epsilon);

    y[i] = (x[i] / rms) * gamma[i];
}
"#;

/// WGSL shader: residual add (y = x + residual).
pub const SHADER_RESIDUAL_ADD: &str = r#"
@group(0) @binding(0) var<storage, read_write> x: array<f32>;
@group(0) @binding(1) var<storage, read>       residual: array<f32>;

struct Uniforms {
    num_elements: u32,
}
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if i >= uniforms.num_elements {
        return;
    }
    x[i] = x[i] + residual[i];
}
"#;
