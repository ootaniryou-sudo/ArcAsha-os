/**
 * code.execute Capability（H3）— ArcAsha が固定する最初の Capability 名。
 *
 *   CodingAttachment → code.execute → Harness → NativeHarness / DeepSeekHarnessAdapter
 *
 * H3 では Capability Resolver / Router を導入しない（仕様書 §23, §42）。
 * code.execute は 1 つの Coding Task を 1 つの Harness で実行し、
 * 観測イベント列（progress 観測）と分類結果を返す。
 *
 * 失敗の意味論:
 *   - completed  → ok: true
 *   - failed     → ok: false + error（タスク失敗。Harness は存続可能）
 *   - cancelled  → ok: false + error（code=CANCELLED, cancel ≠ failed）
 *   - detached   → HarnessInfrastructureError（iteration が切り離された）
 *   - iterator throw → そのまま伝播（infrastructure failure）
 */
import type { Harness } from './harness.js';
import type { HarnessTask, HarnessExecutionError } from './types.js';
import { HarnessInfrastructureError } from './types.js';
import type { HarnessEvent } from './events.js';
import { consumeHarness } from './consume.js';
import { resolveHarness } from './registry.js';
import { DeepSeekHarnessAdapter } from './deepseek.js';

/** 最初に固定する Capability 名（仕様書 §23）。 */
export const CODE_EXECUTE = 'code.execute';

export interface CodeExecuteOptions {
  /** 使用する Harness。既定: resolveHarness('deepseek')（DSH 不可なら Native にフォールバック）。 */
  harness?: Harness;
  signal?: AbortSignal;
  cancelGracePeriodMs?: number;
}

export interface CodeExecuteResult {
  ok: boolean;
  /** 成果テキスト（生成コード等）。 */
  output: string;
  /** 実行試行 ID（同一 task でも実行ごとに異なる）。 */
  executionId: string | null;
  /** 観測したイベント列（progress 観測）。 */
  events: HarnessEvent[];
  /** 実測レイテンシ（ms）。 */
  latencyMs: number;
  /** 選択された Harness の種類。 */
  harnessKind: 'native' | 'deepseek';
  /** failed / cancelled 時の失敗情報。 */
  error?: HarnessExecutionError;
}

/**
 * 1 つの Coding Task を Harness で実行する。既定では DeepSeek 優先・不可なら Native へ
 * フォールバックする（Rollback Safety）。同一 task を複数回呼ぶと executionId は毎回異なる。
 */
export async function codeExecute(
  task: HarnessTask,
  options: CodeExecuteOptions = {},
): Promise<CodeExecuteResult> {
  const started = performance.now();
  const events: HarnessEvent[] = [];
  const harness = options.harness ?? (await resolveHarness('deepseek'));
  const harnessKind = harness instanceof DeepSeekHarnessAdapter ? 'deepseek' : 'native';

  const outcome = await consumeHarness(harness, task, {
    signal: options.signal,
    cancelGracePeriodMs: options.cancelGracePeriodMs,
    onEvent: (e) => events.push(e),
  });

  const latencyMs = performance.now() - started;
  switch (outcome.status) {
    case 'completed':
      return { ok: true, output: outcome.result.output, executionId: outcome.executionId, events, latencyMs, harnessKind };
    case 'failed':
      return { ok: false, output: '', executionId: outcome.executionId, events, latencyMs, harnessKind, error: outcome.error };
    case 'cancelled':
      return {
        ok: false,
        output: '',
        executionId: outcome.executionId,
        events,
        latencyMs,
        harnessKind,
        error: { code: 'CANCELLED', message: outcome.reason, retryable: false },
      };
    case 'detached':
      throw new HarnessInfrastructureError(`code.execute が detach された: ${outcome.reason}`);
    default:
      // exhaustive check 用（全 status は上で処理済み）
      throw new HarnessInfrastructureError('未知の outcome status');
  }
}
