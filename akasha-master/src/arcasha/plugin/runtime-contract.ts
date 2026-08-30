/**
 * Intelligence Runtime 契約（Runtime Contract）— Future Orchestrator が
 * ArcAsha を「交換可能なプラグイン」として接続するための安定した境界面。
 *
 * 方針（RESEARCH_PLAN.md Phase 2 — Boundary Fix）:
 *   - 本命 Orchestrator への依存を作らない。単独で価値が証明できる。
 *   - この契約が「後から Adapter を書く」ための seam になる。
 *
 * createIntelligenceRuntime() は既存の AILSM/AILSA/AVM/ExpertHub を隠蔽して、
 * この契約の実装（アダプタ）として公開する。中身は大幅な作り直しではなく
 * 既存実装の「窓口を安定化」したもの。
 */
import 'dotenv/config';
import { ExpertHub } from '../experts/registry.js';
import { initAiOs, aiosExecute } from '../ailsm/aios.js';
import type { AiOs } from '../ailsm/aios.js';
import { AvmWorkspace } from '../chat/avm-telemetry.js';
import { buildFleet, classifyTask, routeExpert } from './model-fleet.js';
import type { FleetExpert, TaskKind } from './model-fleet.js';

/** 能力宣言（Orchestrator がプラグインの出来ることを発見するために使う） */
export interface RuntimeCapability {
  name: string;
  description?: string;
}

/** Future Orchestrator が ArcAsha に渡すタスク */
export interface RuntimeRequest {
  task: string;
  /** AVM に登録する追加知識（省略可） */
  context?: string;
  maxTokens?: number;
  deadlineMs?: number;
  priority?: number;
  /** タスク種別を明示（省略時は自動分類） */
  forceKind?: TaskKind;
}

/** プラグイン境界を越える安定した実行結果 */
export interface RuntimeResult {
  ok: boolean;
  answer: string | null;
  kind: TaskKind;
  expert: string;
  model: string;
  nodeId: string;
  ms: number;
  fallback: boolean;
  learned: boolean;
  memory: {
    reads: number;
    writes: number;
    modelCalls: number;
    residentPages: number;
    residentBytes: number;
  };
  trace: string[];
  error?: string;
}

export interface RuntimeStatus {
  name: string;
  version: string;
  nodes: number;
  model: string;
  fleet: { nodeId: string; model: string; role: string; label: string }[];
}

/** プラグイン境界: Intelligence Runtime 契約 */
export interface IntelligenceRuntime {
  readonly name: string;
  readonly version: string;
  capabilities(): RuntimeCapability[];
  submit(req: RuntimeRequest): Promise<RuntimeResult>;
  status(): RuntimeStatus;
  dispose(): Promise<void>;
}

export interface CreateRuntimeOptions {
  verbose?: boolean;
  /** true のとき API キーを無視してモックのみ（selftest / 検証用） */
  forceMock?: boolean;
  /** AVM（仮想メモリ）を有効にする（既定 true） */
  memory?: boolean;
}

/** 既存の ArcAsha 実装を IntelligenceRuntime 契約へ適合させるアダプタ */
export function createIntelligenceRuntime(opts: CreateRuntimeOptions = {}): IntelligenceRuntime {
  const hub = new ExpertHub();
  const fleet = buildFleet(hub, { verbose: opts.verbose ?? true, forceMock: opts.forceMock });
  const aios: AiOs = initAiOs({
    listNodes: () => hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
    generate: async (nodeId, p, m = 256) => hub.generate(nodeId, String(p), Number(m) || 256),
  });
  const memory = opts.memory ?? true;
  const ws = memory ? new AvmWorkspace() : null;
  let seq = 0;

  const memStats = () => {
    if (!ws) return { reads: 0, writes: 0, modelCalls: 0, residentPages: 0, residentBytes: 0 };
    const s = ws.snapshot(0).stats;
    return { reads: s.reads, writes: s.writes, modelCalls: s.modelCalls, residentPages: s.residentPages, residentBytes: s.residentBytes };
  };

  const runTurn = async (task: string, context: string | undefined, expert: FleetExpert, maxTokens: number, trace: string[]) => {
    let contextSnippet = '';
    if (ws) {
      const title = `task:${++seq}`;
      ws.storeContext(title, context ?? task, 'user');
      const load = ws.readSlice(title, 'search', task, 'search');
      const kloads = ws.searchKnowledge(task, 2, 'search');
      contextSnippet = [
        load?.loadedText ?? '',
        ...kloads.map((k) => `[知識:${k.title}] ${k.loadedText.slice(0, 800)}`),
      ].filter(Boolean).join('\n').slice(0, 800);
      trace.push(`avm: context.write + slice.read (${load?.pageIds.length ?? 0} pages / 知識 ${kloads.length})`);
    }
    const prompt = [
      'あなたは ArcAsha（AI オペレーティングシステム）の上で動くエキスパートです。',
      contextSnippet ? `以下は AVM（AI 仮想メモリ）から読み込んだコンテキストです:\n─── context ───\n${contextSnippet}\n──────────────` : '',
      `質問: ${task}`,
      '簡潔に日本語で答えてください。',
    ].filter(Boolean).join('\n');
    const ex = await aiosExecute(aios, prompt, expert.nodeId, { forceDelegate: true, maxTokens });
    const answer = ex.result !== null && ex.result !== undefined ? String(ex.result).trim() : '';
    trace.push(`model.call ${expert.model} (${ex.ms}ms) fallback=${ex.fallback ?? false}`);
    return { answer, learned: ex.learned ?? true, fallback: ex.fallback ?? false, ex };
  };

  return {
    name: 'ArcAsha Intelligence Runtime',
    version: '1.0.0',
    capabilities: () => [
      { name: 'aios-execute', description: 'AILSM コンパイル → CALL → エキスパート委譲 → ODAR 学習' },
      { name: 'avm', description: '仮想メモリ（必要ページだけ供給・モデル読み書きを記録）' },
      { name: 'multi-model-routing', description: 'タスク分類による Flash/Pro ルーティング' },
    ],
    async submit(req) {
      const t0 = Date.now();
      const trace: string[] = [];
      const kind = req.forceKind ?? classifyTask(req.task);
      const expert = routeExpert(kind, fleet);
      trace.push(`classify → ${kind}（${expert.label} / ${expert.model}）`);
      const maxTokens = req.maxTokens ?? 256;
      try {
        let { answer, learned, fallback } = await runTurn(req.task, req.context, expert, maxTokens, trace);
        // 空応答（推論モデルが思考に予算を使い切った場合）→ 汎用モデルへフォールバック
        if (answer === '') {
          const fb = fleet.find((e) => e.role === 'general') ?? expert;
          trace.push(`空応答 → フォールバック ${fb.label}`);
          const r2 = await runTurn(req.task, req.context, fb, maxTokens, trace);
          answer = r2.answer;
          learned = r2.learned;
          fallback = r2.fallback;
        }
        if (answer === '') answer = '（応答が空でした）';
        return {
          ok: true,
          answer,
          kind,
          expert: expert.label,
          model: expert.model,
          nodeId: expert.nodeId,
          ms: Date.now() - t0,
          fallback,
          learned,
          memory: memStats(),
          trace,
        } satisfies RuntimeResult;
      } catch (e) {
        trace.push(`error: ${String(e).slice(0, 120)}`);
        return {
          ok: false,
          answer: null,
          kind,
          expert: expert.label,
          model: expert.model,
          nodeId: expert.nodeId,
          ms: Date.now() - t0,
          fallback: false,
          learned: false,
          memory: memStats(),
          trace,
          error: String(e).slice(0, 200),
        } satisfies RuntimeResult;
      }
    },
    status: () => ({
      name: 'ArcAsha Intelligence Runtime',
      version: '1.0.0',
      nodes: hub.experts.length,
      model: fleet[0]?.model ?? '',
      fleet: fleet.map((e) => ({ nodeId: e.nodeId, model: e.model, role: e.role, label: e.label })),
    }),
    dispose: async () => {
      // 現状、Hub はインメモリのためクローズ処理なし（将来 WebSocket 切断時などで利用）
    },
  };
}
