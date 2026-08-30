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
  const memoryEnabled = opts.memory ?? true;
  let seq = 0;

  const memStats = (w: AvmWorkspace | null) => {
    if (!w) return { reads: 0, writes: 0, modelCalls: 0, residentPages: 0, residentBytes: 0 };
    const s = w.snapshot(0).stats;
    return { reads: s.reads, writes: s.writes, modelCalls: s.modelCalls, residentPages: s.residentPages, residentBytes: s.residentBytes };
  };

  interface TurnResult {
    answer: string;
    learned: boolean;
    fallback: boolean;
    driverOk: boolean;
    model: string;
    nodeId: string;
    label: string;
    ms: number;
  }

  /**
   * 1 ターン実行。AVM は呼び出し単位の workspace（w）で分離 — 他タスクの文脈を引かない。
   * 明示された context のみ索引・プロンプトへ渡す（素のタスク文を知識として残さない）。
   */
  const runTurn = async (
    task: string,
    explicitContext: string | undefined,
    expert: FleetExpert,
    maxTokens: number,
    w: AvmWorkspace | null,
    trace: string[],
  ): Promise<TurnResult> => {
    let avmSnippet = '';
    // タイトルを一度だけ採番して再利用（同時 submit で共有 seq が進んでも
    // このターンの AVM コンテキストへ正しく書き込めるように）
    const title = w && explicitContext ? `task:${++seq}` : undefined;
    if (w && explicitContext && title) {
      w.storeContext(title, explicitContext, 'user');
      const load = w.readSlice(title, 'search', task, 'search');
      const kloads = w.searchKnowledge(task, 2, 'search');
      avmSnippet = [
        load?.loadedText ?? '',
        ...kloads.map((k) => `[知識:${k.title}] ${k.loadedText.slice(0, 800)}`),
      ].filter(Boolean).join('\n').slice(0, 800);
      trace.push(`avm: context.write + slice.read (${load?.pageIds.length ?? 0} pages / 知識 ${kloads.length})`);
    }
    const prompt = [
      'あなたは ArcAsha（AI オペレーティングシステム）の上で動くエキスパートです。',
      explicitContext ? `─── 提供コンテキスト ───\n${explicitContext.slice(0, 800)}\n──────────────` : '',
      avmSnippet ? `─── AVM から読み込んだコンテキスト ───\n${avmSnippet}\n──────────────` : '',
      `質問: ${task}`,
      '簡潔に日本語で答えてください。',
    ].filter(Boolean).join('\n');
    const t1 = Date.now();
    const ex = await aiosExecute(aios, prompt, expert.nodeId, { forceDelegate: true, maxTokens });
    const ms = Date.now() - t1;
    const answer = ex.result !== null && ex.result !== undefined ? String(ex.result).trim() : '';
    const driverOk = ex.driverResponse?.ok !== false;
    if (w) {
      w.recordModelCall(expert.model, ms, `${expert.nodeId} へ ${maxTokens} tokens 上限で生成`);
      // 回答を AVM に書き戻す（捕捉済みの title をキーにも再利用し、同時 submit でも対応を保つ）
      if (explicitContext && title) w.writeCache(title, 'summary', `answer:${title}`, answer, expert.model);
    }
    trace.push(`model.call ${expert.model} (${ms}ms) fallback=${ex.fallback ?? false} driverOk=${driverOk}`);
    return { answer, learned: ex.learned ?? true, fallback: ex.fallback ?? false, driverOk, model: expert.model, nodeId: expert.nodeId, label: expert.label, ms };
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
      const deadline = req.deadlineMs ?? Infinity;
      const maxTokens = req.maxTokens ?? 256;
      const w = memoryEnabled ? new AvmWorkspace() : null;
      trace.push(`classify → ${kind}（${expert.label} / ${expert.model}）`);

      if (Date.now() > deadline) {
        return { ok: false, answer: null, kind, expert: '', model: '', nodeId: '', ms: 0, fallback: false, learned: false, memory: { reads: 0, writes: 0, modelCalls: 0, residentPages: 0, residentBytes: 0 }, trace: [...trace, 'deadline exceeded'], error: 'deadline exceeded' } satisfies RuntimeResult;
      }

      try {
        const first = await runTurn(req.task, req.context, expert, maxTokens, w, trace);
        if (Date.now() > deadline) {
          return { ok: false, answer: null, kind, expert: first.label, model: first.model, nodeId: first.nodeId, ms: Date.now() - t0, fallback: false, learned: false, memory: memStats(w), trace: [...trace, 'deadline exceeded'], error: 'deadline exceeded' } satisfies RuntimeResult;
        }

        // 空応答 or ドライバ失敗 → 汎用モデルへフォールバック
        if (first.answer === '' || !first.driverOk) {
          const fb = fleet.find((e) => e.role === 'general') ?? expert;
          trace.push(`空応答/失敗 → フォールバック ${fb.label}`);
          const second = await runTurn(req.task, req.context, fb, maxTokens, w, trace);
          const used = second.answer !== '' && second.driverOk ? second : first;
          if (used.answer === '' || !used.driverOk) {
            // 両方失敗・空 → 成功と偽装しない
            return {
              ok: false,
              answer: null,
              kind,
              expert: used.label,
              model: used.model,
              nodeId: used.nodeId,
              ms: Date.now() - t0,
              fallback: true,
              learned: used.learned,
              memory: memStats(w),
              trace,
              error: 'empty response or driver failure from both experts',
            } satisfies RuntimeResult;
          }
          return {
            ok: true,
            answer: used.answer === '' ? '（応答が空でした）' : used.answer,
            kind,
            expert: used.label,
            model: used.model,
            nodeId: used.nodeId,
            ms: Date.now() - t0,
            fallback: true,
            learned: used.learned,
            memory: memStats(w),
            trace,
          } satisfies RuntimeResult;
        }
        return {
          ok: true,
          answer: first.answer,
          kind,
          expert: first.label,
          model: first.model,
          nodeId: first.nodeId,
          ms: Date.now() - t0,
          fallback: first.fallback,
          learned: first.learned,
          memory: memStats(w),
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
          memory: memStats(w),
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
