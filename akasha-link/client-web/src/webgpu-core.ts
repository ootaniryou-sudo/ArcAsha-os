/**
 * WebGPU expert — browser-oriented; typed loosely so Node `tsc` stays clean.
 */
import { BinaryCodec } from '../binary/codec.js';
import { Cmd, HEADER_SIZE, MAX_PACKET_BYTES } from '../binary/protocol.js';

type GpuDevice = {
  createBuffer: (desc: Record<string, unknown>) => GpuBuffer;
  createBindGroup: (desc: Record<string, unknown>) => unknown;
  createCommandEncoder: () => GpuEncoder;
  createShaderModule: (desc: { code: string }) => unknown;
  createComputePipeline: (desc: Record<string, unknown>) => GpuPipeline;
  queue: { writeBuffer: (...args: unknown[]) => void; submit: (cmds: unknown[]) => void };
  destroy: () => void;
};

type GpuBuffer = {
  destroy: () => void;
  mapAsync: (mode: number) => Promise<void>;
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
};

type GpuPipeline = { getBindGroupLayout: (i: number) => unknown };

type GpuEncoder = {
  beginComputePass: () => {
    setPipeline: (p: GpuPipeline) => void;
    setBindGroup: (i: number, g: unknown) => void;
    dispatchWorkgroups: (n: number) => void;
    end: () => void;
  };
  copyBufferToBuffer: (...args: unknown[]) => void;
  finish: () => unknown;
};

export async function createWebGpuExpert(): Promise<{
  forward: (input: Float32Array) => Promise<Float32Array>;
  destroy: () => void;
}> {
  const nav = globalThis as typeof globalThis & {
    navigator?: { gpu?: { requestAdapter: () => Promise<{ requestDevice: () => Promise<GpuDevice> } | null> } };
  };

  if (!nav.navigator?.gpu) {
    return {
      forward: async (input) => {
        const out = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) out[i] = Math.tanh(input[i]! * 1.13);
        return out;
      },
      destroy: () => undefined,
    };
  }

  const adapter = await nav.navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();

  const shader = device.createShaderModule({
    code: `
      @group(0) @binding(0) var<storage, read> input : array<f32>;
      @group(0) @binding(1) var<storage, read_write> output : array<f32>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let i = gid.x;
        if (i >= arrayLength(&input)) { return; }
        let x = input[i];
        output[i] = tanh(x * 1.13 + 0.03);
      }
    `,
  });

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: shader, entryPoint: 'main' },
  });

  const STORAGE = 0x80;
  const COPY_DST = 0x08;
  const COPY_SRC = 0x04;
  const MAP_READ = 0x01;
  const MAP_READ_MODE = 0x0001;

  return {
    async forward(input: Float32Array) {
      const bytes = input.byteLength;
      const inBuf = device.createBuffer({
        size: bytes,
        usage: STORAGE | COPY_DST,
      });
      const outBuf = device.createBuffer({
        size: bytes,
        usage: STORAGE | COPY_SRC,
      });
      const readBuf = device.createBuffer({
        size: bytes,
        usage: COPY_DST | MAP_READ,
      });
      device.queue.writeBuffer(inBuf, 0, input.buffer, input.byteOffset, bytes);

      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inBuf } },
          { binding: 1, resource: { buffer: outBuf } },
        ],
      });

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(input.length / 64));
      pass.end();
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, bytes);
      device.queue.submit([enc.finish()]);

      await readBuf.mapAsync(MAP_READ_MODE);
      const out = new Float32Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      inBuf.destroy();
      outBuf.destroy();
      readBuf.destroy();
      return out;
    },
    destroy() {
      device.destroy();
    },
  };
}

export { BinaryCodec, Cmd, HEADER_SIZE, MAX_PACKET_BYTES };
