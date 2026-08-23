/**
 * Recovery Harness（PR 1）— Notebook を Single Source of Truth とする検証駆動エラー回復ループ
 *
 * 設計契約:
 *   - Notebook が状態、RecoveryHarness は「状態遷移を実行する機械」。
 *     RecoveryHarness は独自の Task State / Notebook 改竄を行わない。全ての観測・決定は
 *     Notebook のセクションへ追記される（TASK / PLAN / ANALYSIS / ERRORS / DECISIONS / FINAL_DIAGNOSIS）。
 *   - 閉ループ: EXECUTE → VERIFY → (PASS: DONE | FAIL: DIAGNOSE → RECOVER → EXECUTE)
 *   - Recovery Strategy は型として固定: Retry / Replan / AddExpert / Abort
 *   - Strategy 選択の根拠は必ず Notebook.DECISIONS に残す
 *     （Decision Explanation への接続点。後続 PR の Policy Learning がここを読む）。
 *   - 既存 Harness ABI を実装する decorator。base executor には Native / DSH / 実モデル等の
 *     Harness をそのまま渡せる（consumeHarness / executeOnce と互換）。
 *
 * スコープ（入れる）: Retry/Replan/AddExpert/Abort, maxAttempts, round budget,
 *   failure history（Notebook.ERRORS）, 決定論スナップショット（Notebook v0→vN）
 * スコープ外（PR 2/3 へ）: Oasis retrieval / 大規模 Policy Learning / Dynamic Expert Formation / 実機
 *
 * 研究姿勢: 本モジュールは「同一タスクに対し、Verifier による失敗検出 → 回復戦略選択 →
 * 再実行で完了可能な閉ループを構成できる」ことを証明する。性能改善は主張しない。
 */
import type { Harness } from '../harness/harness.js';
import type { HarnessTask, HarnessExecuteOptions, HarnessResult } from '../harness/types.js';
import {
  HarnessInfrastructureError,
  HarnessCancelledError,
} from '../harness/types.js';
import type { HarnessEvent } from '../harness/events.js';
import { executeOnce } from '../harness/execute-once.js';
import {
  CaravanNotebook,
  type NotebookEntry,
} from './notebook.js';
import {
  verifyArtifactOnly,
  type CaravanDomain,
  type CaravanVerificationResult,
} from './caravan-verifier.js';

/** 回復戦略（型として固定）。Notebook.DECISIONS に action として記録される。 */
export type RecoveryStrategy = 'Retry' | 'Replan' | 'AddExpert' | 'Abort';

/** 回復決定。選択根拠（reason）を必ず持ち、Notebook.DECISIONS に残す。 */
export interface RecoveryDecision {
  action: RecoveryStrategy;
  /** 選択根拠（Decision Explanation）。例: "plan が検証を満たさない" */
  reason: string;
  /** AddExpert 時に追加する能力（例: concurrency / verification / coding） */
  addedCapability?: string;
}

/** 失敗履歴の 1 件（Strategy 選択の入力。Notebook.ERRORS と同内容を集約） */
export interface RecoveryFailure {
  attempt: number;
  /** 失敗種別: verify-fail / executor-failed / round-timeout */
  kind: 'verify-fail' | 'executor-failed' | 'round-timeout';
  issue: string;
  at: number;
}

/** Strategy 選択関数へ渡すコンテキスト（読み取り専用入力） */
export interface RecoveryContext {
  notebook: CaravanNotebook;
  attempt: number;
  verification: CaravanVerificationResult;
  failureHistory: readonly RecoveryFailure[];
}

export interface RecoveryHarnessOptions {
  /** 生成 / 実行を担う基盤 Harness（Native / DSH / 実モデル / 決定論 Simulation） */
  executor: Harness;
  /** Notebook（Single Source of Truth。呼び出し側が所有し、実行後に snapshot で Decision Replay できる） */
  notebook: CaravanNotebook;
  /** ドメイン（coding / math / generic） */
  domain: CaravanDomain;
  /** 最大試行回数（既定 3） */
  maxAttempts?: number;
  /** Round 予算（ms）。1 回の EXECUTE が超過したら round-timeout として失敗 → 回復 */
  roundBudgetMs?: number;
  /** アーティファクト検証（既定: verifyArtifactOnly(notebook, domain)）。plan は必須にしない */
  verify?: (notebook: CaravanNotebook) => CaravanVerificationResult;
  /** 回復戦略選択（既定: defaultRecoveryPolicy）。選択根拠は DECISIONS に書かれる */
  selectStrategy?: (ctx: RecoveryContext) => RecoveryDecision;
}

/** タイムアウト付き Promise（round budget の強制） */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: round timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** ドメイン別のアーティファクト IR キー */
export function artifactKeyFor(domain: CaravanDomain): 'program' | 'solution' | 'analysis' {
  return domain === 'coding' ? 'program' : domain === 'math' ? 'solution' : 'analysis';
}

/** Notebook の現在状態（plan / 直近 errors / 直近 decisions）をタスク文へ合成し、attempt を注入する */
export function buildAttemptTask(
  task: HarnessTask,
  notebook: CaravanNotebook,
  attempt: number,
): HarnessTask {
  const plan = notebook.latest('plan')?.value;
  const errors = notebook
    .entriesOf('errors')
    .slice(-3)
    .map((e) => e.value)
    .join(' ; ');
  const decisions = notebook
    .entriesOf('decisions')
    .slice(-2)
    .map((e) => e.value)
    .join(' ; ');
  const context = [plan, errors, decisions].filter(Boolean).join(' | ');
  return {
    taskId: task.taskId,
    text: context ? `${task.text}\n--- recovery context ---\n${context}` : task.text,
    metadata: { ...task.metadata, attempt, recoveryContext: context },
  };
}

/** 決定を Notebook.DECISIONS に書ける IR 文字列へ整形する */
export function formatDecision(d: RecoveryDecision): string {
  const cap = d.addedCapability !== undefined ? `, addedCapability=${d.addedCapability}` : '';
  return `decision: [action=${d.action}, reason="${d.reason}"${cap}]`;
}

/** 失敗履歴から何の能力が足りないかを推測（AddExpert の addedCapability 用。決定論） */
function capabilityHint(ctx: RecoveryContext): string {
  const t = ctx.notebook.task;
  if (/計算|方程式|解いて|求めて|math|solve|equation|sum/i.test(t)) return 'math';
  if (/実装|コード|プログラミング|関数|バグ|作って|coding|implement|program/i.test(t)) return 'coding';
  return 'verification';
}

/**
 * 既定の回復戦略ポリシー（決定論）。
 *   1. Plan 検証失敗            → Replan（計画を書き換えて再実行）
 *   2. 実行基盤の失敗           → Retry（一時障害は再実行で回復）
 *   3. 形式不良                 → Retry（同一方針のまま再実行）
 *   4. アーティファクト欠落     → AddExpert（不足能力を補う）
 *   5. 未分類                   → Retry
 */
export function defaultRecoveryPolicy(ctx: RecoveryContext): RecoveryDecision {
  const issues = ctx.verification.issues;
  // 1. 計画検証失敗 → 再計画
  if (issues.some((i) => i.verifier === 'Plan')) {
    return { action: 'Replan', reason: 'plan が検証を満たさない', addedCapability: 'planning' };
  }
  // 2. 実行基盤の失敗 → リトライ
  const last = ctx.failureHistory[ctx.failureHistory.length - 1];
  if (last && (last.kind === 'executor-failed' || last.kind === 'round-timeout')) {
    return { action: 'Retry', reason: '実行基盤の一時障害は再実行で回復を試みる' };
  }
  // 3. 形式不良 → リトライ
  if (issues.some((i) => i.verifier === 'Artifact' && /形式|閉じ|IR/.test(i.message))) {
    return { action: 'Retry', reason: 'アーティファクトの形式不良は再実行で修正を試みる' };
  }
  // 4. アーティファクト欠落 → 能力追加
  if (issues.some((i) => i.verifier === 'Artifact' && /無い|欠落|存在し/.test(i.message))) {
    return {
      action: 'AddExpert',
      reason: 'アーティファクトを生成できていないため能力を追加する',
      addedCapability: capabilityHint(ctx),
    };
  }
  // 5. 未分類
  return { action: 'Retry', reason: '未分類の検証失敗は再実行で修正を試みる' };
}

/**
 * Recovery Harness — Harness ABI を実装する検証駆動エラー回復 decorator。
 *
 * 状態遷移（全て Notebook に追記される）:
 *   EXECUTE（buildAttemptTask で Notebook 状態を注入）→ ANALYSIS に成果物追記
 *   → VERIFY（verifyArtifactOnly 等）→ PASS: FINAL_DIAGNOSIS + completed
 *   → FAIL: ERRORS 追記 → selectStrategy → DECISIONS 追記 → recover して再 EXECUTE
 */
export class RecoveryHarness implements Harness {
  private readonly executor: Harness;
  private readonly notebook: CaravanNotebook;
  private readonly domain: CaravanDomain;
  private readonly maxAttempts: number;
  private readonly roundBudgetMs: number;
  private readonly verify: (notebook: CaravanNotebook) => CaravanVerificationResult;
  private readonly selectStrategy: (ctx: RecoveryContext) => RecoveryDecision;

  constructor(opts: RecoveryHarnessOptions) {
    if (!opts.executor) throw new HarnessInfrastructureError('RecoveryHarness: executor が未指定');
    if (!opts.notebook) throw new HarnessInfrastructureError('RecoveryHarness: notebook が未指定');
    this.executor = opts.executor;
    this.notebook = opts.notebook;
    this.domain = opts.domain;
    this.maxAttempts = opts.maxAttempts ?? 3;
    if (this.maxAttempts < 1) throw new HarnessInfrastructureError('RecoveryHarness: maxAttempts は 1 以上');
    this.roundBudgetMs = opts.roundBudgetMs ?? 5_000;
    this.verify = opts.verify ?? ((nb) => verifyArtifactOnly(nb, this.domain));
    this.selectStrategy = opts.selectStrategy ?? defaultRecoveryPolicy;
  }

  /** Single Source of Truth への参照（RecoveryHarness 自身は状態を持たない） */
  get state(): CaravanNotebook {
    return this.notebook;
  }

  async *execute(
    task: HarnessTask,
    options?: HarnessExecuteOptions,
  ): AsyncIterable<HarnessEvent> {
    const executionId = `recovery-${task.taskId}-${Date.now()}`;
    const t0 = Date.now();
    yield { type: 'started', taskId: task.taskId, executionId, timestamp: t0 };
    if (options?.signal?.aborted) {
      throw new HarnessInfrastructureError('RecoveryHarness: aborted before execution');
    }

    const artifactKey = artifactKeyFor(this.domain);
    const failureHistory: RecoveryFailure[] = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (options?.signal?.aborted) {
        throw new HarnessInfrastructureError('RecoveryHarness: aborted during recovery');
      }

      // --- EXECUTE: Notebook の現在状態から attempt タスクを組み立て、基盤で実行する ---
      const attemptTask = buildAttemptTask(task, this.notebook, attempt);
      let result: HarnessResult | null = null;
      let executorError: string | null = null;
      try {
        result = await withTimeout(
          executeOnce(this.executor, attemptTask, { signal: options?.signal }),
          this.roundBudgetMs,
          `round#${attempt}`,
        );
      } catch (e) {
        if (e instanceof HarnessInfrastructureError || e instanceof HarnessCancelledError) {
          throw e; // 基盤の継続不能障害・キャンセルは回復対象にしない
        }
        executorError = e instanceof Error ? e.message : String(e);
      }

      // --- Round 予算 / 実行失敗の検出 ---
      if (result === null) {
        const kind: RecoveryFailure['kind'] =
          executorError !== null && /round timeout/.test(executorError)
            ? 'round-timeout'
            : 'executor-failed';
        const issue = `${kind}: ${executorError?.slice(0, 80) ?? 'unknown'}`;
        this.notebook.fail('recovery', issue, { round: attempt });
        failureHistory.push({ attempt, kind, issue, at: Date.now() });
        const decision = this.selectStrategy({
          notebook: this.notebook,
          attempt,
          verification: { ok: false, issues: [{ verifier: 'Executor', message: issue }] },
          failureHistory,
        });
        this.recordDecision(decision, attempt);
        yield this.messageEvent(task.taskId, executionId, `recover[${attempt}]: ${decision.action} — ${decision.reason}`);
        if (decision.action === 'Abort' || attempt >= this.maxAttempts) {
          yield this.failedEvent(task.taskId, executionId, attempt);
          return;
        }
        continue;
      }

      // --- ANALYSIS: 成果物を Notebook に確定する（Single Source of Truth への書き込み） ---
      this.notebook.append('analysis', artifactKey, result.output, 'recovery-executor', { round: attempt });

      // --- VERIFY: アーティファクト検証（100% 決定論） ---
      const verification = this.verify(this.notebook);
      if (verification.ok) {
        this.notebook.diagnose('recovery', '検証済みの成果物を確定', 0.9, [], { round: attempt });
        yield {
          type: 'completed',
          taskId: task.taskId,
          executionId,
          result: {
            ok: true,
            output: result.output,
            metadata: {
              domain: this.domain,
              attempts: attempt,
              failureHistory: failureHistory.length,
              notebookVersion: this.notebook.snapshot().version,
            },
          },
          timestamp: Date.now(),
        };
        return;
      }

      // --- DIAGNOSE: 検証失敗を ERRORS に記録（失敗履歴） ---
      const issueText = verification.issues.map((i) => `${i.verifier}: ${i.message}`).join(' ; ').slice(0, 120);
      this.notebook.fail('recovery', `verify: ${issueText}`, { round: attempt });
      failureHistory.push({ attempt, kind: 'verify-fail', issue: issueText, at: Date.now() });

      // --- RECOVER: 戦略選択 → DECISIONS に根拠を記録 ---
      const decision = this.selectStrategy({
        notebook: this.notebook,
        attempt,
        verification,
        failureHistory,
      });
      this.recordDecision(decision, attempt);
      yield this.messageEvent(task.taskId, executionId, `recover[${attempt}]: ${decision.action} — ${decision.reason}`);

      if (decision.action === 'Abort' || attempt >= this.maxAttempts) {
        yield this.failedEvent(task.taskId, executionId, attempt);
        return;
      }
      // Retry / Replan / AddExpert は次の attempt で再 EXECUTE する
    }

    // 到達しない（ループは上で必ず terminal event を返す）
    yield this.failedEvent(task.taskId, executionId, this.maxAttempts);
  }

  /** 回復決定を Notebook.DECISIONS へ追記する（根拠の永続化。これが Policy Learning の入力） */
  private recordDecision(decision: RecoveryDecision, attempt: number): NotebookEntry {
    return this.notebook.append('decisions', 'decision', formatDecision(decision), 'recovery', {
      round: attempt,
    });
  }

  private messageEvent(taskId: string, executionId: string, text: string): HarnessEvent {
    return { type: 'message', taskId, executionId, text, timestamp: Date.now() };
  }

  private failedEvent(taskId: string, executionId: string, attempts: number): HarnessEvent {
    return {
      type: 'failed',
      taskId,
      executionId,
      error: {
        code: 'RECOVERY_EXHAUSTED',
        message: `回復不能（attempts=${attempts} / maxAttempts=${this.maxAttempts}）`,
        retryable: true,
      },
      timestamp: Date.now(),
    };
  }
}

/**
 * 決定論 Simulation Executor（テスト / デモ用）— attempt ごとにアーティファクトを生成する Harness。
 *
 * produce(attempt, task) が undefined を返す attempt は failed イベント（実行失敗）を発行する。
 * 基盤が失敗した場合に attempt metadata を元に再実行できること、および
 * recoveryContext（直近 DECISIONS 等）を参照して動作を変えられることの検証に使う。
 */
export function createAttemptArtifactHarness(opts: {
  domain: CaravanDomain;
  produce: (attempt: number, task: HarnessTask) => string | undefined;
}): Harness {
  return {
    async *execute(task: HarnessTask, options?: HarnessExecuteOptions): AsyncIterable<HarnessEvent> {
      if (options?.signal?.aborted) throw new HarnessInfrastructureError('scripted: aborted');
      const attempt = Number(task.metadata?.attempt ?? 1);
      const executionId = `scripted-${task.taskId}-${Date.now()}-${attempt}`;
      yield { type: 'started', taskId: task.taskId, executionId, timestamp: Date.now() };
      const artifact = opts.produce(attempt, task);
      if (artifact === undefined) {
        yield {
          type: 'failed',
          taskId: task.taskId,
          executionId,
          error: {
            code: 'SCRIPTED_FAIL',
            message: `scripted failure on attempt ${attempt}`,
            retryable: true,
          },
          timestamp: Date.now(),
        };
        return;
      }
      yield {
        type: 'completed',
        taskId: task.taskId,
        executionId,
        result: { ok: true, output: artifact, metadata: { attempt } },
        timestamp: Date.now(),
      };
    },
  };
}

/** Notebook から回復実行の要約を組み立てる（デモ / テストの表示用） */
export function summarizeRecovery(notebook: CaravanNotebook): {
  ok: boolean;
  attempts: number;
  strategies: string[];
  finalDiagnosis: string | null;
  snapshotVersion: number;
} {
  const decisions = notebook.entriesOf('decisions').map((e) => e.value);
  const diagnosis = notebook.latest('diagnosis')?.value ?? null;
  return {
    ok: diagnosis !== null,
    attempts: decisions.length,
    strategies: decisions.map((d) => /action=(\w+)/.exec(d)?.[1] ?? '?'),
    finalDiagnosis: diagnosis,
    snapshotVersion: notebook.snapshot().version,
  };
}

/** Recovery Harness を consumeHarness 互換の単発 API で使い、Notebook 状態と結果を返す（デモ/テスト用） */
export async function runRecoveryOnce(
  harness: RecoveryHarness,
  task: HarnessTask,
  options?: HarnessExecuteOptions,
): Promise<HarnessResult> {
  return executeOnce(harness, task, options);
}
