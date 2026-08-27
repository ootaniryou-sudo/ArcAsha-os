/**
 * akasha-link/client-web — メインUIスレッド / Main UI Thread
 *
 * スマホ画面にVRAM使用量やマイクロ秒単位の推論遅延を表示する
 * リアルタイムダッシュボード。
 *
 * ## 責務
 * - WebWorker の起動・ライフサイクル管理
 * - OSのバックグラウンドタスクキルを防止する監視層（requestAnimationFrame ループ）
 * - ダッシュボードUI（VRAM / トークン/秒 / レイテンシー）の描画
 * - マスター設定（接続先IP）のUI提供
 */

// ─── Configuration ─────────────────────────────────────────────────────────

interface DashboardConfig {
  masterUrl: string;
  nodeId: string;
  clusterId: number;
  role: string;
}

// ─── Worker handle ─────────────────────────────────────────────────────────

let inferenceWorker: Worker | null = null;

function spawnWorker(config: DashboardConfig): void {
  // Terminate existing worker if any
  if (inferenceWorker) {
    inferenceWorker.terminate();
    inferenceWorker = null;
  }

  inferenceWorker = new Worker('/public/worker-inference.js', {
    type: 'module',
  });

  // Send configuration to the worker
  inferenceWorker.postMessage({
    type: 'init',
    masterUrl: config.masterUrl,
    nodeId: config.nodeId,
    clusterId: config.clusterId,
  });

  // Receive telemetry from the worker
  inferenceWorker.onmessage = (ev: MessageEvent) => {
    handleWorkerMessage(ev.data);
  };

  inferenceWorker.onerror = (err) => {
    updateStatus(`Worker error: ${err.message}`, 'error');
  };
}

// ─── Dashboard state ───────────────────────────────────────────────────────

interface DashboardState {
  status: string;
  statusClass: string;
  gpuVramUsed: string;
  gpuVramTotal: string;
  vramPercent: number;
  tokensPerSec: number;
  avgLatencyUs: number;
  totalTokens: number;
  connected: boolean;
  nodeId: string;
  uptime: number;
}

const state: DashboardState = {
  status: 'Disconnected',
  statusClass: 'offline',
  gpuVramUsed: '0',
  gpuVramTotal: '0',
  vramPercent: 0,
  tokensPerSec: 0,
  avgLatencyUs: 0,
  totalTokens: 0,
  connected: false,
  nodeId: '-',
  uptime: 0,
};

// ─── Message handler ───────────────────────────────────────────────────────

function handleWorkerMessage(msg: { type: string; [key: string]: unknown }): void {
  switch (msg.type) {
    case 'connected':
      state.connected = true;
      state.nodeId = String(msg.nodeId ?? '-');
      state.status = `Connected · node ${state.nodeId}`;
      state.statusClass = 'online';
      break;
    case 'disconnected':
      state.connected = false;
      state.status = 'Disconnected — retrying...';
      state.statusClass = 'offline';
      break;
    case 'stats':
      state.tokensPerSec = Number(msg.tps) || 0;
      state.avgLatencyUs = Number(msg.avgLatencyUs) || 0;
      state.totalTokens = Number(msg.totalTokens) || 0;
      state.gpuVramUsed = formatBytes(Number(msg.vramUsed) || 0);
      state.gpuVramTotal = formatBytes(Number(msg.vramTotal) || 0);
      state.vramPercent = Math.min(
        100,
        ((Number(msg.vramUsed) || 0) / Math.max(1, Number(msg.vramTotal) || 1)) * 100,
      );
      break;
    case 'token':
      // Streamed token — could display in a text area
      break;
    case 'error':
      updateStatus(String(msg.message), 'error');
      break;
  }
  render();
}

// ─── UI helpers ────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GiB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function updateStatus(msg: string, cls: string): void {
  state.status = msg;
  state.statusClass = cls;
  render();
}

// ─── Render loop ───────────────────────────────────────────────────────────

function render(): void {
  const root = document.getElementById('dashboard');
  if (!root) return;

  root.innerHTML = `
    <div class="status-bar ${state.statusClass}">
      <span class="dot"></span>
      <span>${state.status}</span>
    </div>
    <div class="metrics">
      <div class="metric">
        <span class="label">Tokens/s</span>
        <span class="value">${state.tokensPerSec.toFixed(1)}</span>
      </div>
      <div class="metric">
        <span class="label">Latency</span>
        <span class="value">${(state.avgLatencyUs / 1000).toFixed(2)} ms</span>
      </div>
      <div class="metric">
        <span class="label">Total Tokens</span>
        <span class="value">${state.totalTokens}</span>
      </div>
      <div class="metric">
        <span class="label">GPU VRAM</span>
        <span class="value">
          ${state.gpuVramUsed} / ${state.gpuVramTotal}
          <div class="vram-bar">
            <div class="vram-fill" style="width:${state.vramPercent}%"></div>
          </div>
        </span>
      </div>
    </div>
  `;
}

// ─── OS keep-alive (prevents mobile browser tab throttling) ────────────────

function keepAliveLoop(_timestamp: number): void {
  // A continuous requestAnimationFrame loop signals to the browser
  // that this tab is actively doing work, reducing the chance of
  // timer throttling (especially on iOS Safari).
  if (state.connected && inferenceWorker) {
    // Ping the worker to keep the message channel active
    inferenceWorker.postMessage({ type: 'ping' });
  }
  requestAnimationFrame(keepAliveLoop);
}

// ─── Init ──────────────────────────────────────────────────────────────────

function init(): void {
  const config: DashboardConfig = {
    masterUrl: localStorage.getItem('akasha-master-url') || 'ws://localhost:8080',
    nodeId: '',
    clusterId: 0,
    role: '',
  };

  // Render initial UI
  render();

  // Spawn the inference worker
  spawnWorker(config);

  // Start keep-alive loop
  requestAnimationFrame(keepAliveLoop);

  // Periodic uptime counter
  setInterval(() => {
    state.uptime++;
    if (state.connected && inferenceWorker) {
      inferenceWorker.postMessage({ type: 'getStats' });
    }
  }, 1000);
}

// ─── Start on DOM ready ────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
