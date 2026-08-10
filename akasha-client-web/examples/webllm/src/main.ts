/**
 * ArcAsha × WebLLM PoC — メインスレッド
 *
 * - WebGPU 対応確認（navigator.gpu）
 * - CreateWebWorkerMLCEngine で Worker 側にモデルをロード
 * - OpenAI 互換 chat.completions で推論
 * - 統計（トークン/秒・レイテンシ）をダッシュボード表示
 *
 * iPhone Safari (iOS 18+) で動作確認することを想定。
 */
import { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm';

// ─── モデル定義（prebuiltAppConfig に存在する ID のみ） ──────────────────────
interface ModelOption {
  id: string;
  label: string;
  vram: string;
  note: string;
}

const MODELS: ModelOption[] = [
  { id: 'Qwen3-0.6B-q0f32-MLC', label: 'Qwen3-0.6B (q0f32)', vram: '~3.8GB', note: 'ArcAsha 実験と同一ファミリ' },
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5-0.5B (q4f16)', vram: '~945MB', note: '低リソース向け' },
  { id: 'SmolLM2-135M-Instruct-q0f16-MLC', label: 'SmolLM2-135M (q0f16)', vram: '~360MB', note: 'iOS Metal ノードと同等' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama-3.2-1B (q4f16)', vram: '~879MB', note: '汎用' },
];

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
};

const statusEl = $('#status');
const gpuEl = $('#gpu');
const modelSel = $('#model') as HTMLSelectElement;
const btnLoad = $('#btnLoad') as HTMLButtonElement;
const btnSend = $('#btnSend') as HTMLButtonElement;
const inputEl = $('#input') as HTMLInputElement;
const outputEl = $('#output');
const progressEl = $('#progress');
const statsEl = $('#stats');

// ─── 状態 ───────────────────────────────────────────────────────────────────
let engine: Awaited<ReturnType<typeof CreateWebWorkerMLCEngine>> | null = null;
let loading = false;

function setStatus(text: string, cls = ''): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function appendOutput(role: 'user' | 'assistant', text: string): void {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = `${role === 'user' ? '🧑' : '🤖'} ${text}`;
  outputEl.appendChild(div);
  outputEl.scrollTop = outputEl.scrollHeight;
}

// ─── WebGPU 検出 ────────────────────────────────────────────────────────────
async function detectWebGpu(): Promise<void> {
  const nav = navigator as Navigator & { gpu?: GPU };
  if (!nav.gpu) {
    gpuEl.textContent = 'WebGPU: 非対応（iOS 18+ / Safari 26 が必要）';
    gpuEl.className = 'bad';
    return;
  }
  const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    gpuEl.textContent = 'WebGPU: adapter なし';
    gpuEl.className = 'bad';
    return;
  }
  const info = adapter.info;
  const desc = info
    ? `${info.vendor || ''} ${info.architecture || ''} ${info.device || ''}`.trim()
    : 'unknown';
  gpuEl.textContent = `WebGPU: ✅ ${desc}`;
  gpuEl.className = 'ok';
}

// ─── モデルロード ───────────────────────────────────────────────────────────
async function loadModel(): Promise<void> {
  if (loading) return;
  loading = true;
  btnLoad.disabled = true;
  btnSend.disabled = true;
  progressEl.textContent = '';
  outputEl.textContent = '';

  const modelId = modelSel.value;
  const started = performance.now();
  try {
    engine = await CreateWebWorkerMLCEngine(
      new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
      modelId,
      {
        initProgressCallback: (p) => {
          const pct = Math.round((p.progress ?? 0) * 100);
          progressEl.textContent = `[${pct}%] ${p.text || ''}`;
          setStatus(`モデルロード中… ${pct}%`);
        },
      },
    );
    const sec = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(`✅ ロード完了 (${sec}s) — ${modelId}`);
    btnSend.disabled = false;
    appendOutput('assistant', 'モデル準備完了。メッセージをどうぞ。');
  } catch (err) {
    console.error(err);
    setStatus(`❌ ロード失敗: ${err instanceof Error ? err.message : String(err)}`, 'bad');
    appendOutput('assistant', `ロード失敗: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading = false;
    btnLoad.disabled = false;
  }
}

// ─── チャット ───────────────────────────────────────────────────────────────
async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text || !engine) return;
  inputEl.value = '';
  appendOutput('user', text);

  const t0 = performance.now();
  let reply = '';
  let tokens = 0;
  try {
    const chunks = await engine.chat.completions.create({
      messages: [{ role: 'user', content: text }],
      // エッジデバイス向け: 生成を上限で制限（無限生成・過度な消費を防止）
      max_tokens: 128,
      temperature: 0.7,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of chunks) {
      reply += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) tokens = chunk.usage.completion_tokens ?? 0;
      // リアルタイム表示
      const last = outputEl.lastElementChild as HTMLElement | null;
      if (last) last.textContent = `🤖 ${reply}`;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  } catch (err) {
    console.error(err);
    appendOutput('assistant', `エラー: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const ms = performance.now() - t0;
  const tps = ms > 0 && tokens > 0 ? ((tokens / ms) * 1000).toFixed(1) : '—';
  statsEl.textContent = `${tokens} tokens / ${ms.toFixed(0)}ms / ${tps} tok/s`;
  appendOutput('assistant', reply);
}

// ─── 初期化 ─────────────────────────────────────────────────────────────────
function init(): void {
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.label} (${m.vram}) — ${m.note}`;
    modelSel.appendChild(opt);
  }
  void detectWebGpu();
  btnLoad.addEventListener('click', () => void loadModel());
  btnSend.addEventListener('click', () => void send());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void send();
  });
}

init();
