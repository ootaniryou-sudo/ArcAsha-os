/**
 * Memory Harness（PR 2）— Knowledge Oasis を長期記憶とする検索・注入・実行・記録ループ
 *
 * 設計契約:
 *   - Notebook が実行時状態、KnowledgeOasis が長期記憶。MemoryHarness は
 *     「記憶の検索（RETRIEVE）→ 注入（INJECT）→ 実行（EXECUTE）→ 記録（RECORD）」を
 *     実行する機械。Oasis を直接書き換えず、記録は明示的な recordBack 経由で行う。
 *   - 閉ループ:
 *       RETRIEVE（Oasis.search/recommend で類似経験を取得）
 *     → INJECT（タスク文へ過去知識を合成 + Notebook.context に memory IR を追記）
 *     → EXECUTE（基盤 Harness で実行）
 *     → RECORD（結果を Oasis へ記録。次回の検索に供する）
 *   - 既存 Harness ABI を実装する decorator。base executor には Native / DSH / 実モデル /
 *     決定論 Simulation（createMemoryAwareExecutor）を渡せる。
 *
 * スコープ（入れる）: Oasis retrieval / memory 注入 / record back / Notebook 接続
 *   （context.memory 記録 + recordCaravan）/ maxMemory 上限 / 決定論 Simulation
 * スコープ外（PR 3 へ）: 大規模 Policy Learning / 実機 / 性能比較
 *
 * 研究姿勢: 本モジュールは「同一タスク系列で Oasis に蓄積した過去知識を注入する
 * ことで、実行を改善できる閉ループを構成できる」ことを証明する。性能改善は主張しない。
 */
import type { Harness } from '../harness/harness.js';
import type { HarnessTask, HarnessExecuteOptions, HarnessResult } from '../harness/types.js';
import {
  HarnessInfrastructureError,
  HarnessCancelledError,
  HarnessTaskError,
} from '../harness/types.js';
import type { HarnessEvent } from '../harness/events.js';
import { executeOnce } from '../harness/execute-once.js';
import type { CaravanNotebook } from './notebook.js';
import { KnowledgeOasis, makeLesson, type OasisEntry } from './oasis.js';

/** 注入するメモリ文脈（RETRIEVE の結果を構造化したもの） */
export interface MemoryContext {
  task: string;
  /** 取得した類似経験の件数 */
  retrieved: number;
  /** 参照元タスク（Task Archive） */
  sources: string[];
  /** 過去の教訓（Lesson Archive） */
  lessons: string[];
}

/** 検索関数（差し替え可。既定は recommend: 成功・高品質を優先） */
export type MemoryRetriever = (
  task: HarnessTask,
  oasis: KnowledgeOasis,
  max: number,
) => OasisEntry[];

export interface MemoryHarnessOptions {
  /** 実行を担う基盤 Harness（Native / DSH / 実モデル / 決定論 Simulation） */
  executor: Harness;
  /** 長期記憶（Knowledge Oasis）。MemoryHarness は直接書き換えず、検索・記録の口として使う */
  oasis: KnowledgeOasis;
  /** 実行時状態（Single Source of Truth）。あれば context.memory を追記し、recordCaravan で記録する */
  notebook?: CaravanNotebook;
  /** 検索で取得する経験の上限（既定 3） */
  maxMemory?: number;
  /** 検索関数（既定: defaultMemoryRetriever = oasis.recommend） */
  retriever?: MemoryRetriever;
  /** 実行結果を Oasis へ記録するか（既定 true）。false なら読み取り専用で使う */
  recordBack?: boolean;
  /** 実行予算（ms）。超過時は failed（retryable） */
  roundBudgetMs?: number;
}

/** タイムアウト付き Promise（実行予算の強制） */
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

/** 既定の検索: 成功率・品質の高い順に推薦（Caravan の参考と同じ基準） */
export function defaultMemoryRetriever(
  task: HarnessTask,
  oasis: KnowledgeOasis,
  max: number,
): OasisEntry[] {
  return oasis.recommend(task.text).slice(0, max);
}

/** メモリ文脈を Notebook.DECISIONS 同様の IR 文字列へ整形する */
export function formatMemory(m: MemoryContext): string {
  const src = m.sources.length > 0 ? `sources=[${m.sources.join(' ; ')}]` : 'sources=[]';
  const lessons = m.lessons.length > 0 ? ` lessons=[${m.lessons.join(' ; ')}]` : '';
  return `memory: [retrieved=${m.retrieved}, ${src}${lessons}]`;
}

/** タスク文へメモリ文脈を合成し、metadata.memory に IR を注入する（基盤 Harness が読める形） */
export function buildMemoryTask(task: HarnessTask, memory: MemoryContext): HarnessTask {
  const memo = formatMemory(memory);
  return {
    taskId: task.taskId,
    text: `${task.text}\n--- memory context ---\n${memo}`,
    metadata: { ...task.metadata, memory: memo },
  };
}

/** 注入済みメモリを task から取り出す（テスト / 基盤 Harness が参照する） */
export function parseInjectedMemory(task: HarnessTask): {
  retrieved: number;
  sources: string[];
  lessons: string[];
} {
  const raw = typeof task.metadata?.memory === 'string' ? task.metadata.memory : '';
  const retrieved = Number(/retrieved=(\d+)/.exec(raw)?.[1] ?? 0);
  const sources = (/sources=\[(.*?)\]/.exec(raw)?.[1] ?? '').split(' ; ').filter(Boolean);
  const lessons = (/lessons=\[(.*?)\]/.exec(raw)?.[1] ?? '').split(' ; ').filter(Boolean);
  return { retrieved, sources, lessons };
}

/**
 * Memory Harness — Harness ABI を実装する検索・注入・実行・記録 decorator。
 *
 * 状態遷移（Notebook があれば context に追記）:
 *   RETRIEVE（oasis.recommend）→ INJECT（タスク文 + Notebook.context.memory）
 *   → EXECUTE（基盤で実行）→ RECORD（recordBack 時: Oasis へ成功/失敗を記録）
 */
export class MemoryHarness implements Harness {
  private readonly executor: Harness;
  private readonly oasis: KnowledgeOasis;
  private readonly notebook?: CaravanNotebook;
  private readonly maxMemory: number;
  private readonly retriever: MemoryRetriever;
  private readonly recordBack: boolean;
  private readonly roundBudgetMs: number;

  constructor(opts: MemoryHarnessOptions) {
    if (!opts.executor) throw new HarnessInfrastructureError('MemoryHarness: executor が未指定');
    if (!opts.oasis) throw new HarnessInfrastructureError('MemoryHarness: oasis が未指定');
    this.executor = opts.executor;
    this.oasis = opts.oasis;
    this.notebook = opts.notebook;
    this.maxMemory = opts.maxMemory ?? 3;
    if (this.maxMemory < 0) throw new HarnessInfrastructureError('MemoryHarness: maxMemory は 0 以上');
    this.retriever = opts.retriever ?? defaultMemoryRetriever;
    this.recordBack = opts.recordBack ?? true;
    this.roundBudgetMs = opts.roundBudgetMs ?? 5_000;
  }

  /** 長期記憶への参照（MemoryHarness は状態を持たない） */
  get memory(): KnowledgeOasis {
    return this.oasis;
  }

  async *execute(
    task: HarnessTask,
    options?: HarnessExecuteOptions,
  ): AsyncIterable<HarnessEvent> {
    const executionId = `memory-${task.taskId}-${Date.now()}`;
    yield { type: 'started', taskId: task.taskId, executionId, timestamp: Date.now() };
    if (options?.signal?.aborted) {
      throw new HarnessInfrastructureError('MemoryHarness: aborted before execution');
    }

    // --- RETRIEVE: Oasis から類似経験を取得 ---
    const entries = this.retriever(task, this.oasis, this.maxMemory);
    const memory: MemoryContext = {
      task: task.text,
      retrieved: entries.length,
      sources: entries.map((e) => e.task).filter((s): s is string => s !== undefined && s.length > 0),
      lessons: entries.map((e) => e.lesson).filter((l) => typeof l === 'string' && l.length > 0),
    };

    // --- INJECT: Notebook（あれば）の context に memory IR を追記 + タスク文へ合成 ---
    if (this.notebook) {
      this.notebook.append('context', 'memory', formatMemory(memory), 'memory-harness', { round: 1 });
    }
    const memoryTask = buildMemoryTask(task, memory);
    yield {
      type: 'message',
      taskId: task.taskId,
      executionId,
      text: `memory: retrieved=${memory.retrieved} sources=[${memory.sources.join(' ; ')}]`,
      timestamp: Date.now(),
    };

    // --- EXECUTE: 基盤 Harness で実行（メモリ注入済みタスク） ---
    let result: HarnessResult | null = null;
    let failure: { code: string; message: string; retryable: boolean } | null = null;
    try {
      result = await withTimeout(
        executeOnce(this.executor, memoryTask, { signal: options?.signal }),
        this.roundBudgetMs,
        `memory-round`,
      );
    } catch (e) {
      if (e instanceof HarnessInfrastructureError || e instanceof HarnessCancelledError) {
        throw e; // 基盤の継続不能障害・明示的キャンセルは記録対象にしない
      }
      // 内側のタスク失敗（failed イベント）はコードを引き継いで記録・報告する
      failure = e instanceof HarnessTaskError
        ? { ...e.error }
        : { code: 'EXECUTOR_FAILED', message: e instanceof Error ? e.message : String(e), retryable: true };
    }

    if (failure !== null || result === null) {
      // --- RECORD: 失敗を Oasis に記録 ---
      const message = failure?.message ?? 'no result';
      if (this.recordBack) this.recordOutcome(task, 'fail', 0.2, message);
      yield {
        type: 'failed',
        taskId: task.taskId,
        executionId,
        error: failure ?? { code: 'NO_RESULT', message, retryable: true },
        timestamp: Date.now(),
      };
      return;
    }

    // --- RECORD: 成功を Oasis に記録（recordBack 時） ---
    const quality = typeof result.metadata?.quality === 'number' ? result.metadata.quality : result.ok ? 0.9 : 0.3;
    if (this.recordBack) this.recordOutcome(task, result.ok ? 'success' : 'fail', quality, result.output);

    yield {
      type: 'completed',
      taskId: task.taskId,
      executionId,
      result: {
        ok: result.ok,
        output: result.output,
        metadata: { ...result.metadata, memory: memory.retrieved, sources: memory.sources },
      },
      timestamp: Date.now(),
    };
  }

  /** 実行結果を Oasis へ記録する（Notebook があれば snapshot 付きで recordCaravan） */
  private recordOutcome(task: HarnessTask, result: 'success' | 'fail', quality: number, detail: string): void {
    const lesson = makeLesson(task.text, ['memory-harness'], result === 'success', quality, `detail: ${detail.slice(0, 60)}`);
    if (this.notebook) {
      this.oasis.recordCaravan({
        task: task.text,
        team: ['memory-harness'],
        result,
        quality,
        lesson,
        confidence: result === 'success' ? 0.8 : 0.5,
        notebookSnapshot: this.notebook.snapshot(),
      });
    } else {
      this.oasis.record({
        task: task.text,
        team: ['memory-harness'],
        graph: [],
        hypothesis: [],
        result,
        quality,
        lesson,
        confidence: result === 'success' ? 0.8 : 0.5,
        at: Date.now(),
      });
    }
  }
}

/**
 * 決定論 Simulation Executor（テスト / デモ用）— 注入されたメモリを参照して成果物を生成する Harness。
 *
 * produce(task) が undefined を返す場合は failed イベント（実行失敗）を発行する。
 * メモリ注入の有無・内容（parseInjectedMemory）で挙動を変えられることを検証する。
 */
export function createMemoryAwareExecutor(opts: {
  domain: 'coding' | 'math' | 'generic';
  produce: (task: HarnessTask) => string | undefined;
}): Harness {
  return {
    async *execute(task: HarnessTask, options?: HarnessExecuteOptions): AsyncIterable<HarnessEvent> {
      if (options?.signal?.aborted) throw new HarnessInfrastructureError('memory-scripted: aborted');
      const executionId = `memory-scripted-${task.taskId}-${Date.now()}`;
      yield { type: 'started', taskId: task.taskId, executionId, timestamp: Date.now() };
      const artifact = opts.produce(task);
      if (artifact === undefined) {
        yield {
          type: 'failed',
          taskId: task.taskId,
          executionId,
          error: { code: 'MEMORY_SCRIPTED_FAIL', message: 'memory-aware scripted failure', retryable: true },
          timestamp: Date.now(),
        };
        return;
      }
      yield {
        type: 'completed',
        taskId: task.taskId,
        executionId,
        result: { ok: true, output: artifact, metadata: { memoryAware: true } },
        timestamp: Date.now(),
      };
    },
  };
}

/** Memory Harness を consumeHarness / executeOnce 互換の単発 API で使う（デモ/テスト用） */
export async function runMemoryOnce(
  harness: MemoryHarness,
  task: HarnessTask,
  options?: HarnessExecuteOptions,
): Promise<HarnessResult> {
  return executeOnce(harness, task, options);
}
