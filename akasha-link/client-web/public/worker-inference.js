// src/worker.ts
var HEADER_BYTES = 20;
var TX_ID_BYTES = 16;
var MAX_FLOATS = 65536;
var MAX_PACKET = HEADER_BYTES + MAX_FLOATS * 4;
var WORKGROUP = 64;
var HEARTBEAT_MS = 400;
var STATS_MS = 100;
var ArrayBufferPool = class {
  constructor(byteLength, max) {
    this.byteLength = byteLength;
    this.max = max;
    for (let i = 0; i < Math.min(8, max); i++) {
      this.free.push(new ArrayBuffer(byteLength));
      this.created++;
    }
  }
  byteLength;
  max;
  free = [];
  created = 0;
  acquire() {
    const b = this.free.pop();
    if (b) return b;
    if (this.created < this.max) {
      this.created++;
      return new ArrayBuffer(this.byteLength);
    }
    return new ArrayBuffer(this.byteLength);
  }
  release(buf) {
    if (buf.byteLength !== this.byteLength) return;
    if (this.free.length < this.max) this.free.push(buf);
  }
};
var txIdScratch = new Uint8Array(TX_ID_BYTES);
function unpackPacket(ab, byteLength) {
  if (byteLength < HEADER_BYTES) {
    throw new Error(`truncated packet ${byteLength}B`);
  }
  const dv = new DataView(ab, 0, byteLength);
  const src = new Uint8Array(ab, 0, TX_ID_BYTES);
  txIdScratch.set(src);
  let end = TX_ID_BYTES;
  while (end > 0 && txIdScratch[end - 1] === 0) end--;
  let txIdAscii = "";
  for (let i = 0; i < end; i++) txIdAscii += String.fromCharCode(txIdScratch[i]);
  const layerId = dv.getInt32(16, true);
  const payloadByteLength = byteLength - HEADER_BYTES;
  if (payloadByteLength & 3) {
    throw new Error(`payload not f32-aligned: ${payloadByteLength}`);
  }
  return {
    txIdAscii,
    layerId,
    payloadByteOffset: HEADER_BYTES,
    payloadByteLength,
    floatCount: payloadByteLength >>> 2
  };
}
function packResult(outBuf, srcHeader, outputFloats, outputBytes) {
  const dest = new Uint8Array(outBuf);
  dest.set(new Uint8Array(srcHeader, 0, HEADER_BYTES), 0);
  dest.set(new Uint8Array(outputFloats, 0, outputBytes), HEADER_BYTES);
  return HEADER_BYTES + outputBytes;
}
var WebGpuLayerEngine = class {
  device;
  adapterInfo = "unknown";
  pipeline;
  bindGroupLayout;
  slots = [];
  vramBytes = 0;
  maxSlots;
  slotBytes;
  uniformBuf;
  constructor(maxSlots = 4, maxFloats = MAX_FLOATS) {
    this.maxSlots = maxSlots;
    this.slotBytes = maxFloats * 4;
  }
  get vramUsed() {
    return this.vramBytes;
  }
  get vramCap() {
    return this.maxSlots * (this.slotBytes * 3) + 256;
  }
  async init() {
    const nav = self.navigator;
    if (!nav.gpu) throw new Error("WebGPU unavailable in this Worker");
    const adapter = await nav.gpu.requestAdapter({
      powerPreference: "high-performance"
    });
    if (!adapter) throw new Error("no GPU adapter");
    const info = adapter.info ?? await adapter.requestAdapterInfo?.();
    this.adapterInfo = info ? `${info.vendor || ""} ${info.architecture || info.device || ""}`.trim() || "WebGPU" : "WebGPU";
    this.device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.max(this.slotBytes, 128 * 1024 * 1024),
        maxComputeWorkgroupStorageSize: 16384
      }
    });
    this.device.lost.then((info2) => {
      postStats({ status: "error", error: `GPU lost: ${info2.message}` });
    });
    const shader = this.device.createShaderModule({
      label: "akasha-layer-ffn",
      code: LAYER_WGSL
    });
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
      ]
    });
    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: { module: shader, entryPoint: "main" }
    });
    this.uniformBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "akasha-uniform"
    });
    this.vramBytes += 16;
    for (let i = 0; i < this.maxSlots; i++) {
      this.slots.push(this.createSlot(this.slotBytes));
    }
  }
  createSlot(byteCapacity) {
    const usageIn = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const usageOut = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    const usageSt = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    const input = this.device.createBuffer({
      size: byteCapacity,
      usage: usageIn,
      label: "akasha-in"
    });
    const output = this.device.createBuffer({
      size: byteCapacity,
      usage: usageOut,
      label: "akasha-out"
    });
    const staging = this.device.createBuffer({
      size: byteCapacity,
      usage: usageSt,
      label: "akasha-staging"
    });
    this.vramBytes += byteCapacity * 3;
    return { input, output, staging, bindGroup: null, byteCapacity, inUse: false };
  }
  bindGroupFor(slot) {
    if (slot.bindGroup) return slot.bindGroup;
    slot.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: slot.input } },
        { binding: 1, resource: { buffer: slot.output } },
        { binding: 2, resource: { buffer: this.uniformBuf } }
      ]
    });
    return slot.bindGroup;
  }
  acquireSlot(needBytes) {
    if (needBytes > this.slotBytes) {
      throw new Error(`activation ${needBytes}B exceeds slot ${this.slotBytes}B`);
    }
    for (const s2 of this.slots) {
      if (!s2.inUse) {
        s2.inUse = true;
        return s2;
      }
    }
    const s = this.createSlot(this.slotBytes);
    s.inUse = true;
    this.slots.push(s);
    return s;
  }
  releaseSlot(s) {
    s.inUse = false;
  }
  /**
   * Zero-copy upload: writeBuffer from the WS packet's ArrayBuffer at offset 20.
   * Returns latency in microseconds and a pooled host buffer holding the RESULT floats.
   */
  async computeFromPacket(packet, payloadByteOffset, payloadByteLength, layerId, hostOutPool2) {
    const slot = this.acquireSlot(payloadByteLength);
    const floatCount = payloadByteLength >>> 2;
    try {
      this.device.queue.writeBuffer(
        slot.input,
        0,
        packet,
        payloadByteOffset,
        payloadByteLength
      );
      uniScratchDv.setInt32(0, layerId, true);
      uniScratchDv.setUint32(4, floatCount, true);
      this.device.queue.writeBuffer(this.uniformBuf, 0, uniScratch);
      const bindGroup = this.bindGroupFor(slot);
      const t0 = performance.now();
      const enc = this.device.createCommandEncoder({ label: "akasha-enc" });
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(floatCount / WORKGROUP));
      pass.end();
      enc.copyBufferToBuffer(slot.output, 0, slot.staging, 0, payloadByteLength);
      this.device.queue.submit([enc.finish()]);
      await slot.staging.mapAsync(GPUMapMode.READ, 0, payloadByteLength);
      const latencyUs = (performance.now() - t0) * 1e3;
      const hostOut = hostOutPool2.acquire();
      const mapped = slot.staging.getMappedRange(0, payloadByteLength);
      new Uint8Array(hostOut, 0, payloadByteLength).set(new Uint8Array(mapped));
      slot.staging.unmap();
      return { latencyUs, hostOut, hostBytes: payloadByteLength };
    } finally {
      this.releaseSlot(slot);
    }
  }
  destroy() {
    for (const s of this.slots) {
      s.input.destroy();
      s.output.destroy();
      s.staging.destroy();
    }
    this.uniformBuf?.destroy();
    this.device?.destroy();
  }
};
var LAYER_WGSL = (
  /* wgsl */
  `
struct Uniforms {
  layer_id : i32,
  count    : u32,
  _pad0    : u32,
  _pad1    : u32,
};

@group(0) @binding(0) var<storage, read> input  : array<f32>;
@group(0) @binding(1) var<storage, read_write> output : array<f32>;
@group(0) @binding(2) var<uniform> uni : Uniforms;

fn hash_weight(layer : i32, i : u32) -> f32 {
  var x = u32(layer) * 747796405u + i * 2891336453u;
  x = (x ^ (x >> 16u)) * 0x45d9f3bu;
  x = (x ^ (x >> 16u)) * 0x45d9f3bu;
  x = x ^ (x >> 16u);
  // map to (-1.5, 1.5)
  return f32(x & 0x00FFFFFFu) / f32(0x00800000u) - 1.5;
}

fn silu(v : f32) -> f32 {
  return v / (1.0 + exp(-v));
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= uni.count) { return; }
  let x = input[i];
  let w = hash_weight(uni.layer_id, i);
  let b = f32(uni.layer_id) * 0.001;
  output[i] = silu(x * w + b);
}
`
);
var uniScratch = new ArrayBuffer(16);
var uniScratchDv = new DataView(uniScratch);
var packetPool = new ArrayBufferPool(MAX_PACKET, 32);
var hostOutPool = new ArrayBufferPool(MAX_FLOATS * 4, 16);
var resultPool = new ArrayBufferPool(MAX_PACKET, 16);
var engine = null;
var ws = null;
var status = "boot";
var heartbeatOk = false;
var lastHeartbeatAt = 0;
var lastLatencyUs = 0;
var ewmaLatencyUs = 0;
var tasksDone = 0;
var currentLayerId = -1;
var currentTxId = "";
var lastError = "";
var heartbeatTimer = null;
var statsTimer = null;
var computing = false;
var nodeId = "edge-0001";
var clusterId = 2;
var configuredUrl = "ws://127.0.0.1:8080";
function postStats(partial) {
  const msg = {
    type: "stats",
    status: partial?.status ?? status,
    heartbeatOk: partial?.heartbeatOk ?? heartbeatOk,
    lastHeartbeatAgeMs: lastHeartbeatAt ? performance.now() - lastHeartbeatAt : -1,
    vramBytes: engine?.vramUsed ?? 0,
    vramCapBytes: engine?.vramCap ?? 0,
    lastLatencyUs: partial?.lastLatencyUs ?? lastLatencyUs,
    ewmaLatencyUs: partial?.ewmaLatencyUs ?? ewmaLatencyUs,
    tasksDone,
    layerId: currentLayerId,
    txId: currentTxId,
    wsState: ws?.readyState ?? 3,
    gpuName: engine?.adapterInfo ?? "\u2014",
    error: partial?.error ?? (lastError || void 0)
  };
  self.postMessage(msg);
}
async function ensureGpu() {
  if (engine) return;
  engine = new WebGpuLayerEngine(4, MAX_FLOATS);
  await engine.init();
}
function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    heartbeatOk = false;
    return;
  }
  const buf = packetPool.acquire();
  const u8 = new Uint8Array(buf);
  u8.fill(0, 0, HEADER_BYTES);
  const id = nodeId.slice(0, TX_ID_BYTES);
  for (let i = 0; i < id.length; i++) u8[i] = id.charCodeAt(i);
  new DataView(buf).setInt32(16, -1, true);
  ws.send(new Uint8Array(buf, 0, HEADER_BYTES));
  packetPool.release(buf);
  heartbeatOk = true;
  lastHeartbeatAt = performance.now();
}
async function onBinary(data) {
  if (computing) {
    return;
  }
  computing = true;
  status = "computing";
  postStats();
  try {
    await ensureGpu();
    const pkt = unpackPacket(data, data.byteLength);
    currentTxId = pkt.txIdAscii;
    currentLayerId = pkt.layerId;
    if (pkt.layerId === -1) {
      heartbeatOk = true;
      lastHeartbeatAt = performance.now();
      return;
    }
    const result = await engine.computeFromPacket(
      data,
      pkt.payloadByteOffset,
      pkt.payloadByteLength,
      pkt.layerId,
      hostOutPool
    );
    lastLatencyUs = result.latencyUs;
    ewmaLatencyUs = ewmaLatencyUs === 0 ? result.latencyUs : 0.2 * result.latencyUs + 0.8 * ewmaLatencyUs;
    tasksDone++;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const outPacket = resultPool.acquire();
      const total = packResult(outPacket, data, result.hostOut, result.hostBytes);
      ws.send(new Uint8Array(outPacket, 0, total));
      resultPool.release(outPacket);
    }
    hostOutPool.release(result.hostOut);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    status = "error";
    postStats({ error: lastError });
  } finally {
    computing = false;
    if (status !== "error") status = "idle";
    postStats();
  }
}
function connect(url) {
  disconnect();
  configuredUrl = url;
  status = "connecting";
  postStats();
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    status = "idle";
    heartbeatOk = true;
    lastHeartbeatAt = performance.now();
    const reg = new ArrayBuffer(HEADER_BYTES + 4);
    const u8 = new Uint8Array(reg);
    const id = nodeId.slice(0, TX_ID_BYTES);
    for (let i = 0; i < id.length; i++) u8[i] = id.charCodeAt(i);
    const dv = new DataView(reg);
    dv.setInt32(16, -2, true);
    dv.setInt32(20, clusterId, true);
    ws.send(reg);
    if (heartbeatTimer != null) clearInterval(heartbeatTimer);
    heartbeatTimer = self.setInterval(sendHeartbeat, HEARTBEAT_MS);
    postStats();
  };
  ws.onmessage = (ev) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) {
      void onBinary(data);
    } else if (data instanceof Blob) {
      void data.arrayBuffer().then((ab) => onBinary(ab));
    }
  };
  ws.onerror = () => {
    lastError = "WebSocket error";
    heartbeatOk = false;
    postStats({ error: lastError });
  };
  ws.onclose = () => {
    status = "offline";
    heartbeatOk = false;
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    postStats();
  };
}
function disconnect() {
  if (heartbeatTimer != null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
    }
    ws = null;
  }
  status = "offline";
  heartbeatOk = false;
  postStats();
}
self.onmessage = (ev) => {
  const cmd = ev.data;
  if (!cmd || typeof cmd !== "object") return;
  if (cmd.type === "configure") {
    if (cmd.nodeId) nodeId = cmd.nodeId;
    if (cmd.clusterId != null) clusterId = cmd.clusterId;
    if (cmd.url) configuredUrl = cmd.url;
    return;
  }
  if (cmd.type === "connect") {
    void ensureGpu().then(() => connect(cmd.url ?? configuredUrl)).catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      status = "error";
      postStats({ error: lastError });
    });
    return;
  }
  if (cmd.type === "disconnect") {
    disconnect();
  }
};
void ensureGpu().then(() => {
  status = "idle";
  postStats();
}).catch((err) => {
  lastError = err instanceof Error ? err.message : String(err);
  status = "error";
  postStats({ error: lastError });
});
if (statsTimer != null) clearInterval(statsTimer);
statsTimer = self.setInterval(() => postStats(), STATS_MS);
