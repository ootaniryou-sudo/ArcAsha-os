/**
 * Caravan Cognitive E2E（PR 4）— Memory → Caravan Loop → Verifier → Recovery → Formation の一本通し
 *
 * 「1 タスクを OS の全層で通す」＝ Caravan Cognitive E2E:
 *
 *   Task → Oasis Retrieval(Memory) → Notebook init → Planner → Expert execution
 *     → Verifier → FAIL → Recovery(戦略選択) → Formation(Expert 追加候補)
 *     → 再実行 → PASS → Final Diagnosis → Oasis(記録) → 次の Caravan
 *
 * 設計契約:
 *   - Notebook が状態。全状態遷移（EXECUTE / VERIFY / RECOVERY / FORMATION）は Notebook 経由。
 *   - MemoryHarness / RecoveryHarness / ExpertFormation の既存部品を合成する（境界を曖昧にしない）。
 *   - **実モデル / API 接続口**: `ModelExecutor`（差し替え可）。未指定なら決定論 Simulation。
 *     `modelFromHarness()` で既存 Harness（Native / DSH / ACP）を実モデルとして接続できる。
 *   - Ablation 用の構成フラグ: memory / recovery / formation を個別に ON/OFF できる。
 *
 * 研究姿勢: 本モジュールは「同一タスクを全層（Memory → Loop → Verifier → Recovery →
 * Formation）で一本通しに実行できる」ことを証明する。性能改善は主張しない
 * （比較は次段階の Ablation Benchmark）。
 */
import type { Harness } from '../harness/harness.js';
import type { HarnessTask } from '../harness/types.js';
import { executeOnce } from '../harness/execute-once.js';
import { CaravanNotebook } from './notebook.js';
import type { NotebookExpert, NotebookSection } from './notebook.js';
import { detectCaravanDomain, verifyCaravanArtifact, type CaravanDomain, type CaravanVerificationResult } from './caravan-verifier.js';
import { composeTeam } from './capability-graph.js';
import type { KnowledgeOasis } from './oasis.js';
import { makeLesson } from './oasis.js';
import type { PoolExpert } from './pool.js';
import { defaultMemoryRetriever, formatMemory, type MemoryContext } from './memory-harness.js';
import { defaultRecoveryPolicy, formatDecision, type RecoveryContext, type RecoveryDecision, type RecoveryFailure } from './recovery-harness.js';
import { defaultFormationPolicy, formationExpertFromPool, expertIOFor, formatFormationDecision, type ExpertFormationPolicy, type FormationContext } from './expert-formation.js';
import type { CaravanRoundLog } from './caravan-loop.js';

/** 実モデル / API への 1 回の呼び出し（ModelExecutor の入力） */
export interface ModelCall {
  task: string;
  expert: string; // 役割 id（planning / coding / ...）
  round: number;
  /** Notebook の見える部分（Need-to-know の view） */
  view: string;
}

/**
 * 実モデル / API 実行口。IR を返す（ok=false なら失敗として記録される）。
 * tokens は推定トークン（コスト計算に使う。未指定なら 0）。
 */
export type ModelExecutor = (call: ModelCall) => Promise<{ ir: string; ok: boolean; ms: number; tokens?: number }>;

/** トークン単価（コスト推定用。$2 / 1M tokens 相当） */
export const DEFAULT_TOKEN_COST = 0.000002;

/** 既存 Harness（Native / DSH / ACP 等）を ModelExecutor として接続する実モデル口 */
export function modelFromHarness(harness: Harness, makePrompt: (call: ModelCall) => string): ModelExecutor {
  return async (call) => {
    const task: HarnessTask = {
      taskId: `e2e-${call.expert}-${Date.now()}`,
      text: makePrompt(call),
      metadata: { expert: call.expert, round: call.round },
    };
    const t0 = Date.now();
    try {
      const result = await executeOnce(harness, task, {});
      const ms = Date.now() - t0;
      // HarnessResult にトークン使用量があれば metadata から取り出す（無ければ 0 のまま）
      const usage = (result.metadata as { usage?: { tokens?: number } } | undefined)?.usage;
      const tokens = typeof usage?.tokens === 'number' ? usage.tokens : 0;
      return { ir: result.output, ok: result.ok, ms, tokens };
    } catch {
      return { ir: 'error: モデル実行失敗', ok: false, ms: Date.now() - t0, tokens: 0 };
    }
  };
}

export interface CaravanE2EOptions {
  task: string;
  /** AI Pool（composeTeam / formation に必要） */
  pool: readonly PoolExpert[];
  /** 長期記憶（あれば記録 / memory 構成時は検索） */
  oasis?: KnowledgeOasis;
  /** チーム（未指定なら composeTeam(pool, task) で自動編成） */
  team?: readonly NotebookExpert[];
  /** 実モデル / API 接続口（未指定なら決定論 Simulation） */
  model?: ModelExecutor;
  /** Memory（Oasis RETRIEVE → INJECT）を有効化 */
  memory?: boolean;
  /** Recovery（検証失敗 → 戦略選択 → 再実行）を有効化 */
  recovery?: boolean;
  /** Formation（不足能力 → Expert 追加）を有効化 */
  formation?: boolean;
  /** 最大 attempt 数（既定 3） */
  maxAttempts?: number;
  /** 1 Expert あたりの実行予算（ms）。超過時はタイムアウトとして失敗（チーム全体では最大 team×本予算） */
  roundBudgetMs?: number;
  /** ドメイン（未指定なら detectCaravanDomain） */
  domain?: CaravanDomain;
  /** 成果物検証（既定: verifyCaravanArtifact(nb, domain)） */
  verifier?: (nb: CaravanNotebook) => CaravanVerificationResult;
  /** Recovery 戦略選択（既定: defaultRecoveryPolicy） */
  selectStrategy?: (ctx: RecoveryContext) => RecoveryDecision;
  /** Formation ポリシー（既定: defaultFormationPolicy） */
  formationPolicy?: ExpertFormationPolicy;
}

export type E2EStopReason = 'verified' | 'max-attempts' | 'aborted';

export interface CaravanE2EResult {
  task: string;
  domain: CaravanDomain;
  success: boolean;
  stopReason: E2EStopReason;
  /** 実行 attempt 数（再実行含む） */
  attempts: number;
  latencyMs: number;
  /** 推定トークン（モデル利用量。Simulation は 0） */
  tokens: number;
  /** 推定コスト（tokens × 単価） */
  cost: number;
  memoryUsed: boolean;
  recoveryUsed: boolean;
  formationUsed: boolean;
  /** 最終チーム（id） */
  team: string[];
  notebook: CaravanNotebook;
  rounds: CaravanRoundLog[];
  verification: CaravanVerificationResult;
  finalDiagnosis?: string;
}

/** IR 値からキーを抽出（例: "program: [...]" → "program"） */
function irKey(ir: string): string {
  const m = /^([a-z][a-z0-9_-]*)\s*:/.exec(ir);
  return m ? m[1] : 'note';
}

/** タイムアウト付き Promise */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${what} がタイムアウト（${ms}ms）`));
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** PoolExpert を E2E のメンバーへ変換（model があれば model を使い、なければ決定論 Simulation） */
export function e2eExpertFromPool(
  p: PoolExpert,
  io: { readSections: readonly NotebookSection[]; writeSections: readonly NotebookSection[] },
  model: ModelExecutor | undefined,
): NotebookExpert {
  if (!model) return formationExpertFromPool(p, io);
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    readSections: io.readSections,
    writeSections: io.writeSections,
    execute: async ({ task, round, view }) => {
      const r = await model({
        task,
        expert: p.id,
        round,
        view: view.map((v) => v.value).join('\n'),
      });
      return { ir: r.ir, ms: r.ms, ok: r.ok, tokens: r.tokens };
    },
  };
}

/**
 * Caravan Cognitive E2E — 全層（Memory → Loop → Verifier → Recovery → Formation）を一本通しで実行する。
 *
 * 構成フラグ（memory / recovery / formation）は Ablation の各構成に対応する。
 */
export async function runCaravanE2E(opts: CaravanE2EOptions): Promise<CaravanE2EResult> {
  if (!opts.pool || opts.pool.length === 0) {
    throw new Error('CaravanE2E: pool が未指定');
  }
  const domain = opts.domain ?? detectCaravanDomain(opts.task);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const roundBudgetMs = opts.roundBudgetMs ?? 5_000;
  const verifier = opts.verifier ?? ((nb: CaravanNotebook) => verifyCaravanArtifact(nb, domain));
  const oasis = opts.oasis;
  const t0 = Date.now();

  // 1. MEMORY: Oasis RETRIEVE → INJECT（memory 構成時）
  let memoryUsed = false;
  let memoryCtx: MemoryContext | null = null;
  if (opts.memory && oasis) {
    const entries = defaultMemoryRetriever({ taskId: 'e2e', text: opts.task, metadata: {} }, oasis, 3);
    memoryCtx = {
      task: opts.task,
      retrieved: entries.length,
      sources: entries.map((e) => e.task).filter((s): s is string => s !== undefined && s.length > 0),
      lessons: entries.map((e) => e.lesson).filter((l) => l.length > 0),
    };
    memoryUsed = true;
  }

  // 2. Notebook init + memory IR を context に追記（Expert が view で読む）
  const notebook = new CaravanNotebook(opts.task);
  if (memoryCtx) {
    notebook.append('context', 'memory', formatMemory(memoryCtx), 'memory-harness', { round: 0 });
  }

  // 3. TEAM（指定 or composeTeam で自動編成）。全員 execute を持つよう変換
  let team: NotebookExpert[];
  if (opts.team && opts.team.length > 0) {
    // 呼び出し側の Need-to-know 契約（readSections / writeSections）を優先する
    team = opts.team.map((ex) =>
      ex.execute
        ? ex
        : e2eExpertFromPool(
            poolOf(opts.pool, ex.id),
            ex.readSections.length > 0 || ex.writeSections.length > 0
              ? { readSections: ex.readSections, writeSections: ex.writeSections }
              : expertIOFor(ex.role),
            opts.model,
          ),
    );
  } else {
    team = composeTeam([...opts.pool], opts.task).members.map((p) => e2eExpertFromPool(p, expertIOFor(p.role), opts.model));
  }

  // 4. 実行ループ（attempt = 1 回のチーム実行 + 検証）
  const rounds: CaravanRoundLog[] = [];
  const failureHistory: RecoveryFailure[] = [];
  let attempts = 0;
  let success = false;
  let stopReason: E2EStopReason = 'max-attempts';
  let finalDiagnosis: string | undefined;
  let recoveryUsed = false;
  let formationUsed = false;
  let tokens = 0;

  const runTeam = async (round: number): Promise<void> => {
    for (const ex of team) {
      if (!ex.execute) continue;
      const view = notebook.view(ex);
      let r: { ir: string; ms: number; ok: boolean; tokens?: number };
      try {
        r = await withTimeout(
          ex.execute({ task: notebook.task, round, view }),
          Math.max(100, roundBudgetMs),
          `expert ${ex.id}`,
        );
      } catch (e) {
        const issue = `executor-failed: ${(e as Error).message.slice(0, 60)}`;
        notebook.fail(ex.id, issue, { round });
        failureHistory.push({ attempt: round, kind: 'executor-failed', issue, at: Date.now() });
        rounds.push({ round, phase: 'EXECUTE', note: `${ex.id}: exception`, spentMs: 0 });
        continue;
      }
      if (r.ok) {
        const section: NotebookSection = ex.writeSections[0];
        try {
          notebook.append(section, irKey(r.ir), r.ir, ex.id, { round, writer: ex });
        } catch {
          const issue = `executor-failed: IR 形式外: ${r.ir.slice(0, 40)}`;
          notebook.fail(ex.id, issue, { round });
          failureHistory.push({ attempt: round, kind: 'executor-failed', issue, at: Date.now() });
        }
      } else {
        const issue = `executor-failed: ${r.ir.slice(0, 60)}`;
        notebook.fail(ex.id, issue, { round });
        failureHistory.push({ attempt: round, kind: 'executor-failed', issue, at: Date.now() });
      }
      tokens += r.tokens ?? 0;
      rounds.push({ round, phase: 'EXECUTE', note: `${ex.id}: ${r.ir.slice(0, 40)}`, spentMs: r.ms });
    }
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    rounds.push({ round: attempt, phase: 'PLAN', note: `attempt=${attempt} team=[${team.map((e) => e.id).join('>')}]`, spentMs: 0 });

    // EXECUTE（チーム順で実行）
    await runTeam(attempt);

    // VERIFY
    const v = verifier(notebook);
    rounds.push({ round: attempt, phase: 'VERIFY', note: v.ok ? 'PASS' : `FAIL(${v.issues.length})`, spentMs: 0 });

    if (v.ok) {
      success = true;
      stopReason = 'verified';
      finalDiagnosis = notebook.diagnose('master', '検証済みの成果物を確定', 0.9, [], { round: attempt }).value;
      rounds.push({ round: attempt, phase: 'DIAGNOSIS', note: finalDiagnosis.slice(0, 48), spentMs: 0 });
      break;
    }

    // FAIL → ERRORS
    notebook.fail('master', `VERIFY 失敗: ${v.issues.map((i) => i.message).join('; ').slice(0, 80)}`, { round: attempt });
    failureHistory.push({
      attempt,
      kind: 'verify-fail',
      issue: v.issues.map((i) => `${i.verifier}: ${i.message}`).join(' ; ').slice(0, 120),
      at: Date.now(),
    });
    rounds.push({ round: attempt, phase: 'REPLAN', note: `検証失敗（attempt=${attempt}）`, spentMs: 0 });

    // RECOVERY（recovery 構成時）: 戦略選択 → DECISIONS
    let decision: RecoveryDecision | undefined;
    if (opts.recovery) {
      recoveryUsed = true;
      const ctx: RecoveryContext = { notebook, attempt, verification: v, failureHistory };
      decision = opts.selectStrategy?.(ctx) ?? defaultRecoveryPolicy(ctx);
      notebook.append('decisions', 'decision', formatDecision(decision), 'recovery', { round: attempt });
      rounds.push({ round: attempt, phase: 'REPLAN', note: `RECOVERY: ${decision.action} — ${decision.reason.slice(0, 40)}`, spentMs: 0 });
      if (decision.action === 'Abort') {
        stopReason = 'aborted';
        break;
      }
    }

    // FORMATION（formation 構成時）: 不足能力 → Expert 追加
    if (opts.formation) {
      const fctx: FormationContext = { task: opts.task, notebook, domain, team, pool: opts.pool, verification: v, round: attempt };
      const fdec = opts.formationPolicy?.(fctx) ?? defaultFormationPolicy(fctx);
      if (fdec.expertId !== null && !team.some((e) => e.id === fdec.expertId)) {
        const p = opts.pool.find((e) => e.id === fdec.expertId);
        if (p) {
          team = [...team, formationExpertFromPool(p, { readSections: fdec.readSections, writeSections: fdec.writeSections })];
          formationUsed = true;
          notebook.append('decisions', 'decision', formatFormationDecision({ ...fdec, expertId: p.id }), 'formation', { round: attempt });
          rounds.push({ round: attempt, phase: 'REPLAN', note: `FORM: +${p.id}（${fdec.reason.slice(0, 40)}）`, spentMs: 0 });
        }
      }
    }
    // Retry / Replan / AddExpert は次の attempt で再実行する（attempt 上限に達したら max-attempts）
  }

  const latencyMs = Date.now() - t0;
  const cost = tokens * DEFAULT_TOKEN_COST;
  const quality = success ? 0.9 : 0.3;

  // RECORD: Oasis（成功 / 失敗 + 完成 Notebook snapshot）
  if (oasis) {
    oasis.recordCaravan({
      task: opts.task,
      team: team.map((e) => e.id),
      result: success ? 'success' : 'fail',
      quality,
      lesson: makeLesson(opts.task, team.map((e) => e.id), success, quality),
      confidence: success ? 0.9 : 0.3,
      notebookSnapshot: notebook.snapshot(),
      plan: notebook.latest('plan')?.value,
      diagnosis: notebook.latest('diagnosis')?.value,
    });
  }

  return {
    task: opts.task,
    domain,
    success,
    stopReason,
    attempts,
    latencyMs,
    tokens,
    cost,
    memoryUsed,
    recoveryUsed,
    formationUsed,
    team: team.map((e) => e.id),
    notebook,
    rounds,
    verification: verifier(notebook),
    ...(finalDiagnosis !== undefined ? { finalDiagnosis } : {}),
  };
}

/** PoolExpert を id で引く（team 指定時に execute を補完するため） */
function poolOf(pool: readonly PoolExpert[], id: string): PoolExpert {
  const p = pool.find((e) => e.id === id);
  if (!p) throw new Error(`AI Pool に ${id} がいません`);
  return p;
}

/** E2E 実行ログの簡易表示（デモ / CLI 用） */
export function renderCaravanE2E(r: CaravanE2EResult): string {
  const lines: string[] = [];
  lines.push(`E2E: ${r.task}`);
  lines.push(`  result    : ${r.success ? '✅ PASS' : '❌ FAIL'}（${r.stopReason} / attempts=${r.attempts}）`);
  lines.push(`  latency   : ${r.latencyMs}ms / tokens=${r.tokens} / cost=$${r.cost.toFixed(5)}`);
  lines.push(`  config    : memory=${r.memoryUsed} recovery=${r.recoveryUsed} formation=${r.formationUsed}`);
  lines.push(`  team      : [${r.team.join('>')}]`);
  for (const row of r.rounds) {
    lines.push(`  [${row.round}] ${row.phase}: ${row.note}`);
  }
  return lines.join('\n');
}
