/**
 * ArcAsha — Expert Hub (エキスパート登録 + WS 推論 + 決定論キャッシュ)
 *
 * コントローラが WS サーバとなり、run_node_hetero.py のノードがクライアントとして接続。
 * LLM 出力は決定論的 (T=0) なので (node, prompt) をキャッシュする (0003D/E の仕組み)。
 */

import WebSocket, { WebSocketServer } from 'ws';
import type { EvalResult, ExpertInfo, Task } from '../core/types.js';
import { evaluateWith } from '../shadow/shadow.js';

const KNOWN_PARAMS: Record<string, number> = {
  'Qwen/Qwen3-0.6B': 596,
  'HuggingFaceTB/SmolLM2-360M-Instruct': 362,
  'unsloth/gemma-3-1b-it': 1000,
  'Qwen/Qwen2.5-Coder-0.5B': 494,
  'HuggingFaceTB/SmolLM2-135M-Instruct': 135,
  'meta-llama/Llama-3.2-1B-Instruct': 1235,
  'unsloth/Llama-3.2-1B-Instruct': 1235,
  'Qwen/Qwen2.5-1.5B-Instruct': 1540,
};

export function paramsOf(modelId: string): number {
  const known = KNOWN_PARAMS[modelId];
  if (known) return known;
  const m = modelId.match(/(\d+\.?\d*)[bB]/);
  return m ? Math.round(parseFloat(m[1]) * 1000) : 500;
}

/** ノードの動作メトリクス（給電・回線速度）。実測が無い場合は決定論シミュレーション（source:'sim'）。 */
export interface NodeMetric {
  batteryPct: number; // 0-100 給電（バッテリー）残量
  rttMs: number;      // 回線速度（往復遅延）
  powerMw: number;    // 推定消費電力
  connectedAt: number;
  lastSeenAt: number;
  source: 'real' | 'sim';
}

/** nodeId から決まる決定論シミュレーション値（毎回同じ → 再現可能）。実機は register 情報で上書き。 */
function simMetric(nodeId: string): { batteryPct: number; rttMs: number; powerMw: number } {
  let h = 0;
  for (let i = 0; i < nodeId.length; i++) h = (h * 31 + nodeId.charCodeAt(i)) >>> 0;
  return {
    batteryPct: 40 + (h % 61),   // 40-100%
    rttMs: 5 + (h % 76),         // 5-80ms
    powerMw: 500 + (h % 1500),   // 0.5-2.0W
  };
}

/**
 * キャラバン（中間マスター「軍曹」）— 増えすぎたデバイスを管理するための階層ノード。
 * CARAVAN_SIZE 台ごとに 1 キャラバンを立て、デバイスの割り当て管理を任せることで、
 * 1000 機レベルのデバイスでも Master が直接扱わずに済む（スケーラブルな木構造）。
 */
export interface Caravan {
  id: string;          // 'caravan-0', 'caravan-1', ...
  memberIds: string[]; // 配下のデバイス（葉）
}

export const CARAVAN_SIZE = 10; // 10 デバイスごとに 1 キャラバン

/** 下層デバイス同士の会話（ニューロンネットワーク風）。別キャラバン間はキャラバンを経由。 */
export interface PeerMessage {
  from: string;
  to: string;
  text: string;
  ts: number;
  relayedBy?: string; // 経由したキャラバン（同一キャラバン内なら undefined = 直接）
}

export class ExpertHub {
  readonly experts: ExpertInfo[] = [];
  /** register 時に送られた生のノード情報 (platform/backend/precision/settings等) */
  readonly nodeDetails = new Map<string, Record<string, unknown>>();
  /** ノードごとの動作メトリクス（給電・回線速度） */
  readonly nodeMetrics = new Map<string, NodeMetric>();
  /** キャラバン（中間マスター）階層: caravanId → 配下デバイス */
  private readonly caravans = new Map<string, Caravan>();
  /** 下層デバイス同士の会話ログ（ニューロン風ピア通信） */
  readonly peerLog: PeerMessage[] = [];
  /** HTTP デバイス（llama.cpp server 等）: nodeId → baseUrl */
  readonly httpNodes = new Map<string, string>();
  /** 外部 API ノード（OpenAI 互換・API キー認証）: nodeId → 設定 */
  readonly apiNodes = new Map<string, { baseUrl: string; apiKey: string; model: string }>();
  /** モックノード（WS 不要の決定論フェイク） */
  readonly mockNodes = new Set<string>();
  private sockets = new Map<string, WebSocket>();
  private cache = new Map<string, EvalResult>();
  private genCache = new Map<string, string>();
  cacheMiss = 0;
  cacheHit = 0;
  genCacheMiss = 0;
  genCacheHit = 0;
  /** 直近の API 生成で使われた実トークン数（ベンチ用・キャッシュヒット時は前回値のまま） */
  lastApiUsage: { promptTokens: number; completionTokens: number } | null = null;
  private started = false;

  /** WS サーバ開始。minNodes 接続で onReady を呼ぶ */
  start(port: number, minNodes: number, onReady: () => void): void {
    if (this.started) return;
    this.started = true;
    const wss = new WebSocketServer({ port });
    wss.on('connection', (ws: WebSocket, req) => {
      const clientIp = req.socket?.remoteAddress || 'unknown';
      let nodeId = `unknown-${clientIp}`;
      ws.on('message', (raw: Buffer) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw.toString()); } catch { return; }
        // トップレベルがオブジェクトでなければ無視（null・配列・プリミティブを拒否）
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        const msg = parsed as Record<string, unknown>;
        if (msg.type === 'register') {
          // msg.node は非 null オブジェクトで、id が非空文字列であることを検証（不正は状態変更せず拒否）
          const node = msg.node;
          if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
          const nodeRec = node as Record<string, unknown>;
          if (typeof nodeRec.id !== 'string' || nodeRec.id === '') return;
          nodeId = nodeRec.id;
          const modelId = typeof nodeRec.model_id === 'string' && nodeRec.model_id !== '' ? nodeRec.model_id : 'unknown';
          const params = paramsOf(modelId);
          this.nodeDetails.set(nodeId, nodeRec);
          const now = Date.now();
          // battery_pct は 0〜100 の有限値のみ受理。それ以外はシミュレーションへフォールバック
          const rawBattery = nodeRec.battery_pct;
          const realBattery =
            typeof rawBattery === 'number' && Number.isFinite(rawBattery) && rawBattery >= 0 && rawBattery <= 100
              ? rawBattery
              : null;
          const sim = simMetric(nodeId);
          this.nodeMetrics.set(nodeId, {
            batteryPct: realBattery ?? sim.batteryPct,
            rttMs: sim.rttMs,
            powerMw: sim.powerMw,
            connectedAt: now,
            lastSeenAt: now,
            source: realBattery !== null ? 'real' : 'sim',
          });
          this.experts.push({
            nodeId,
            modelId,
            family: nodeId.split('-').pop() || 'unknown',
            paramsM: params,
            memoryGB: Math.round((params / 500) * 100) / 100,
            temperature: 0.6,
          });
          this.sockets.set(nodeId, ws);
          ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'ArcAsha' }));
          console.log(`  ✅ expert ${nodeId} (${modelId}, ${params}M) → ${this.assignCaravan(nodeId)}`);
          if (this.experts.length >= minNodes) onReady();
        } else if (msg.type === 'ping') {
          // 回線速度（RTT）計測 — ノードの ping に往復遅延を記録
          const m = this.nodeMetrics.get(nodeId);
          if (m) {
            const t = typeof msg.t === 'number' ? msg.t : Date.now();
            const rtt = Math.max(1, Date.now() - t);
            // 移動平均で安定化（急激な変化を滑らかに）
            m.rttMs = Math.round(m.rttMs * 0.7 + rtt * 0.3);
            m.lastSeenAt = Date.now();
          }
          ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        }
      });
      ws.on('close', () => {
        this.sockets.delete(nodeId);
        this.experts.splice(this.experts.indexOf(this.experts.find(e => e.nodeId === nodeId)!), 1);
        this.removeFromCaravan(nodeId);
      });
      ws.on('error', () => {});
    });
    console.log(`  🟢 ArcAsha ExpertHub on ws://localhost:${port} (need ${minNodes} experts)`);
  }

  /** エキスパートに推論を依頼 (決定論出力キャッシュ付き) */
  async compute(node: ExpertInfo, task: Task): Promise<EvalResult> {
    const key = `${node.nodeId}|${task.prompt}`;
    const hit = this.cache.get(key);
    if (hit) { this.cacheHit++; return hit; }
    const ws = this.sockets.get(node.nodeId);
    if (!ws) throw new Error(`expert ${node.nodeId} not connected`);
    const chat = node.family !== 'qwen';
    const res = await this.sendCompute(ws, `arcasha-${this.cacheMiss}-${node.nodeId}`, task.prompt, chat, 60);
    const val = evaluateWith(node, task, res.text, res.timing.total_ms);
    this.cache.set(key, val);
    this.cacheMiss++;
    return val;
  }

  /** 生テキスト生成 (EXP-0005B LLM Planner 用)。(node,prompt) キャッシュで決定論 */
  async generate(nodeId: string, prompt: string, maxTokens = 200): Promise<string> {
    const key = `gen|${nodeId}|${prompt}`;
    const hit = this.genCache.get(key);
    if (hit !== undefined) { this.genCacheHit++; return hit; }
    // HTTP デバイス（llama.cpp /completion 等）
    const baseUrl = this.httpNodes.get(nodeId);
    if (baseUrl) {
      const text = await this.httpGenerate(baseUrl, prompt, maxTokens);
      this.genCache.set(key, text);
      this.genCacheMiss++;
      return text;
    }
    // 外部 API ノード（OpenAI 互換・API キー認証）
    const apiCfg = this.apiNodes.get(nodeId);
    if (apiCfg) {
      const text = await this.apiGenerate(apiCfg, prompt, maxTokens);
      this.genCache.set(key, text);
      this.genCacheMiss++;
      return text;
    }
    // モックノード（WS 不要の決定論フェイク）
    if (this.mockNodes.has(nodeId)) {
      const family = nodeId.split('-').pop() || 'mock';
      const text = `[MOCK ${family}] received \"${prompt.slice(0, 60)}\" (max_tokens=${maxTokens})`;
      this.genCache.set(key, text);
      this.genCacheMiss++;
      return text;
    }
    const ws = this.sockets.get(nodeId);
    if (!ws) throw new Error(`expert ${nodeId} not connected`);
    const res = await this.sendCompute(ws, `gen-${this.genCacheMiss}-${nodeId}`, prompt, true, maxTokens);
    this.genCache.set(key, res.text);
    this.genCacheMiss++;
    return res.text;
  }

  /**
   * HTTP デバイス（llama.cpp server / OpenAI 互換 API）を呼ぶ。
   * まず llama.cpp の POST /completion を試し、失敗したら /v1/chat/completions を試す。
   */
  private async httpGenerate(baseUrl: string, prompt: string, maxTokens: number): Promise<string> {
    const url = baseUrl.replace(/\/+$/, '');
    // 1) llama.cpp /completion
    try {
      const res = await fetch(`${url}/completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, n_predict: maxTokens, temperature: 0, top_p: 1 }),
      });
      if (res.ok) {
        const data = (await res.json()) as { content?: string; response?: string };
        const text = data.content ?? data.response;
        if (typeof text === 'string') return text;
      }
    } catch { /* fallthrough */ }
    // 2) OpenAI 互換 /v1/chat/completions
    const res2 = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llm',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });
    if (!res2.ok) throw new Error(`HTTP device error ${res2.status}: ${await res2.text()}`);
    const data2 = (await res2.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data2.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('HTTP device returned no content');
    return text;
  }

  /**
   * 外部 API（OpenAI 互換 /v1/chat/completions・API キー認証）を呼ぶ。
   * baseUrl 例: https://api.openai.com  /  https://api.deepseek.com  /  http://localhost:11434/v1
   * （apiKey は Authorization: Bearer ヘッダーで送る）
   */
  private async apiGenerate(cfg: { baseUrl: string; apiKey: string; model: string }, prompt: string, maxTokens: number): Promise<string> {
    const url = cfg.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    // 60 秒のタイムアウト（API が応答しなくてもハングしないように）
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API error ${res.status} (${cfg.model}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    // 実トークン使用量を記録（ベンチの公平な token 比較に使う）
    if (data.usage) {
      this.lastApiUsage = {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
      };
    }
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('API returned no content');
    return text;
  }

  private sendCompute(
    ws: WebSocket,
    requestId: string,
    prompt: string,
    chat: boolean,
    maxTokens = 60,
  ): Promise<{ text: string; timing: { total_ms: number } }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 120000);
      const handler = (raw: Buffer) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === 'result' && m.request_id === requestId) {
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            resolve({ text: m.text, timing: m.timing });
          } else if (m.type === 'error' && m.request_id === requestId) {
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            reject(new Error(`node error: ${m.error}`));
          }
        } catch { /* ignore */ }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({
        type: 'compute', request_id: requestId, prompt,
        max_new_tokens: maxTokens, temperature: 0, top_p: 1, chat,
      }));
    });
  }

  /** 特定ノードを切断（モニターの端末操作） */
  disconnect(nodeId: string): boolean {
    const ws = this.sockets.get(nodeId);
    if (ws) {
      ws.close();
      this.sockets.delete(nodeId);
    }
    this.httpNodes.delete(nodeId);
    this.apiNodes.delete(nodeId);
    this.mockNodes.delete(nodeId);
    const idx = this.experts.findIndex((e) => e.nodeId === nodeId);
    if (idx >= 0) this.experts.splice(idx, 1);
    this.nodeDetails.delete(nodeId);
    this.nodeMetrics.delete(nodeId);
    this.removeFromCaravan(nodeId);
    return true;
  }

  // ─── Web コンソールからのデバイス接続（WS 不要）────────────────

  /**
   * 外部 API（OpenAI 互換・API キー認証）を能力ノードとして登録。
   * baseUrl 例: https://api.openai.com / https://api.deepseek.com / http://localhost:11434/v1
   * →「API も Expert になる」（ローカルモデルに限らず外部知能も同じ能力ノード）
   */
  addApiNode(nodeId: string, baseUrl: string, apiKey: string, model = 'gpt-4o-mini'): boolean {
    if (this.experts.some((e) => e.nodeId === nodeId)) return false;
    const now = Date.now();
    const sim = simMetric(nodeId);
    this.nodeDetails.set(nodeId, {
      platform: 'api',
      device: 'External API',
      backend: 'openai-compatible',
      precision: 'auto',
      baseUrl,
      model,
      hasApiKey: apiKey.length > 0,
      capabilities: { general: 0.95, knowledge: 0.95 },
    });
    this.nodeMetrics.set(nodeId, {
      batteryPct: 100,
      rttMs: sim.rttMs,
      powerMw: 100, // 外部 API はローカル電力消費がほぼ無い
      connectedAt: now,
      lastSeenAt: now,
      source: 'sim',
    });
    this.experts.push({
      nodeId,
      modelId: model,
      family: 'api',
      paramsM: 0,
      memoryGB: 0,
      temperature: 0.6,
    });
    this.apiNodes.set(nodeId, { baseUrl, apiKey, model });
    console.log(`  ✅ api expert ${nodeId} (${model} @ ${baseUrl}) → ${this.assignCaravan(nodeId)}`);
    return true;
  }

  /** モックノードを直接登録（Web 起動時に自動で試せる基盤） */
  addMockNode(nodeId: string, modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct'): boolean {
    if (this.experts.some((e) => e.nodeId === nodeId)) return false;
    const params = paramsOf(modelId);
    const now = Date.now();
    const sim = simMetric(nodeId);
    this.nodeDetails.set(nodeId, {
      platform: 'mock',
      device: 'Mock (no real inference)',
      backend: 'mock',
      precision: 'mock',
      model_id: modelId,
      capabilities: { coding: 0.4, math: 0.4, general: 0.5 },
    });
    this.nodeMetrics.set(nodeId, {
      batteryPct: sim.batteryPct,
      rttMs: sim.rttMs,
      powerMw: sim.powerMw,
      connectedAt: now,
      lastSeenAt: now,
      source: 'sim',
    });
    this.experts.push({
      nodeId,
      modelId,
      family: nodeId.split('-').pop() || 'mock',
      paramsM: params,
      memoryGB: Math.round((params / 500) * 100) / 100,
      temperature: 0.6,
    });
    this.mockNodes.add(nodeId);
    console.log(`  ✅ mock expert ${nodeId} (${modelId}, ${params}M) → ${this.assignCaravan(nodeId)}`);
    return true;
  }

  /**
   * HTTP デバイス（llama.cpp server / OpenAI 互換 API）を直接登録。
   * baseUrl 例: http://192.168.1.10:8080（/completion または /v1/chat/completions）
   */
  addHttpNode(nodeId: string, baseUrl: string, modelId = 'http-llm'): boolean {
    if (this.experts.some((e) => e.nodeId === nodeId)) return false;
    const params = paramsOf(modelId);
    const now = Date.now();
    const sim = simMetric(nodeId);
    this.nodeDetails.set(nodeId, {
      platform: 'http',
      device: 'HTTP device',
      backend: 'http',
      precision: 'auto',
      baseUrl,
      model_id: modelId,
      capabilities: { general: 0.6 },
    });
    this.nodeMetrics.set(nodeId, {
      batteryPct: 100,
      rttMs: sim.rttMs,
      powerMw: 800,
      connectedAt: now,
      lastSeenAt: now,
      source: 'sim',
    });
    this.experts.push({
      nodeId,
      modelId,
      family: nodeId.split('-').pop() || 'http',
      paramsM: params,
      memoryGB: Math.round((params / 500) * 100) / 100,
      temperature: 0.6,
    });
    this.httpNodes.set(nodeId, baseUrl);
    console.log(`  ✅ http expert ${nodeId} (${baseUrl}, ${modelId}) → ${this.assignCaravan(nodeId)}`);
    return true;
  }

  /** 全ノードのメトリクス + 担当ロール（モニター表示用） */
  metrics(): Array<{
    nodeId: string;
    modelId: string;
    paramsM: number;
    family: string;
    batteryPct: number;
    rttMs: number;
    powerMw: number;
    source: 'real' | 'sim';
    connectedAt: number;
    lastSeenAt: number;
    roles: string[];
  }> {
    return this.experts.map((e) => {
      const m = this.nodeMetrics.get(e.nodeId);
      const det = this.nodeDetails.get(e.nodeId) ?? {};
      const caps = det.capabilities;
      // capabilities は配列（ロール名）またはオブジェクト（ロール → スコア）の両対応
      let roles: string[] = [];
      if (Array.isArray(caps)) {
        roles = caps.map((c: unknown) => String(c));
      } else if (caps && typeof caps === 'object') {
        roles = Object.keys(caps).filter((k) => (caps as Record<string, unknown>)[k] !== 0);
      }
      return {
        nodeId: e.nodeId,
        modelId: e.modelId,
        paramsM: e.paramsM,
        family: e.family,
        batteryPct: m?.batteryPct ?? 50,
        rttMs: m?.rttMs ?? 20,
        powerMw: m?.powerMw ?? 1000,
        source: m?.source ?? 'sim',
        connectedAt: m?.connectedAt ?? 0,
        lastSeenAt: m?.lastSeenAt ?? 0,
        roles,
      };
    });
  }

  // ─── キャラバン階層（中間マスター）────────────────────────────────

  /** デバイスをキャラバンに割り当て（CARAVAN_SIZE 台ごとに新キャラバンを立てる） */
  private assignCaravan(nodeId: string): string {
    const last = [...this.caravans.values()].pop();
    if (last && last.memberIds.length < CARAVAN_SIZE) {
      last.memberIds.push(nodeId);
      return last.id;
    }
    const id = `caravan-${this.caravans.size}`;
    this.caravans.set(id, { id, memberIds: [nodeId] });
    return id;
  }

  /** 切断されたデバイスをキャラバンから除去（空になったらキャラバンも削除） */
  private removeFromCaravan(nodeId: string): void {
    for (const [id, c] of this.caravans) {
      const i = c.memberIds.indexOf(nodeId);
      if (i >= 0) {
        c.memberIds.splice(i, 1);
        if (c.memberIds.length === 0) this.caravans.delete(id);
        return;
      }
    }
  }

  /** ノードが所属するキャラバン ID */
  caravanOf(nodeId: string): string | undefined {
    for (const c of this.caravans.values()) {
      if (c.memberIds.includes(nodeId)) return c.id;
    }
    return undefined;
  }

  /**
   * キャラバンの役割（軍曹）: 配下の AI モデルノードのデバイス割り当てを管理する。
   * Master はキャラバン単位でしか扱わないため、1000 機レベルでも耐えられる。
   * タスクキーから配下デバイスを決定論的に割り当てる（ラウンドロビン + ハッシュ分散）。
   */
  caravanRoute(caravanId: string, taskKey: string): string | null {
    const c = this.caravans.get(caravanId);
    if (!c || c.memberIds.length === 0) return null;
    let h = 0;
    for (let i = 0; i < taskKey.length; i++) h = (h * 31 + (taskKey.charCodeAt(i) || 0)) >>> 0;
    return c.memberIds[h % c.memberIds.length];
  }

  /** Master → キャラバン → デバイスの木構造（樹形図表示用） */
  tree(): {
    master: { nodeId: string; name: string; caravanCount: number };
    caravans: Array<{ id: string; members: ReturnType<ExpertHub['metrics']> }>;
  } {
    const memberById = new Map(this.metrics().map((m) => [m.nodeId, m]));
    return {
      master: {
        nodeId: 'master',
        name: 'ArcAsha Master',
        caravanCount: this.caravans.size,
      },
      caravans: [...this.caravans.values()].map((c) => ({
        id: c.id,
        members: c.memberIds
          .map((id) => memberById.get(id))
          .filter((m): m is NonNullable<ReturnType<ExpertHub['metrics']>[number]> => Boolean(m)),
      })),
    };
  }

  // ─── 下層デバイス同士の会話（ニューロンネットワーク風ピア通信）──

  /** デバイス → デバイスの会話。別キャラバン間はキャラバン（軍曹）を経由して中継する。 */
  peerMessage(from: string, to: string, text: string): PeerMessage {
    const fc = this.caravanOf(from);
    const tc = this.caravanOf(to);
    const msg: PeerMessage = {
      from,
      to,
      text,
      ts: Date.now(),
      relayedBy: fc && tc && fc !== tc ? tc : undefined,
    };
    this.peerLog.unshift(msg);
    if (this.peerLog.length > 100) this.peerLog.pop();
    return msg;
  }

  close(): void {
    for (const ws of this.sockets.values()) ws.close();
  }
}
