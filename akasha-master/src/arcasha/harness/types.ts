/**
 * Coding Harness — Task / Execution / Result 型定義（H0）
 *
 * ArcAsha Coding Harness 仕様書の最小 ABI。
 *
 * taskId と executionId は別物:
 *   - taskId       = 論理タスク（retry しても不変）。caller が発行。
 *   - executionId  = 1 回の実行試行。Harness が発行。
 */

/** 論理タスク。retry しても変化しない。 */
export interface HarnessTask {
  /** 論理タスク ID（caller 発行）。executionId と同一視してはならない。 */
  taskId: string;
  /** 実行対象のタスク文。 */
  text: string;
  /** H0 では任意。将来拡張用。 */
  metadata?: Record<string, unknown>;
}

/** 実行オプション。 */
export interface HarnessExecuteOptions {
  /** 停止要求。下位実行（Agent / Tool / subprocess）へ伝播する。 */
  signal?: AbortSignal;
  /** Abort 後、下位実行が停止しない場合の猶予時間（ms）。 */
  cancelGracePeriodMs?: number;
}

/** 実行結果（Harness レベル）。AttachmentResult へは上位（Coding Attachment）で変換する。 */
export interface HarnessResult {
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

/**
 * タスク実行の失敗（failed イベント）。
 * Harness Runtime は存続可能。上位は retry / fallback を判断してよい。
 */
export interface HarnessExecutionError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** Task failure を表す例外（executeOnce が failed を変換して throw）。 */
export class HarnessTaskError extends Error {
  constructor(readonly error: HarnessExecutionError) {
    super(error.message);
    this.name = 'HarnessTaskError';
  }
}

/** 明示的キャンセルを表す例外（executeOnce が cancelled を変換して throw）。cancel ≠ task failure。 */
export class HarnessCancelledError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'HarnessCancelledError';
  }
}

/**
 * Harness / Adapter の継続不能障害（iterator throw 側）。
 * - Adapter 初期化失敗
 * - DSH プロセス起動不能
 * - 通信チャネル喪失
 * - ABI 不整合 / internal invariant violation
 */
export class HarnessInfrastructureError extends Error {
  constructor(message: string, readonly code = 'HARNESS_INFRASTRUCTURE') {
    super(message);
    this.name = 'HarnessInfrastructureError';
  }
}
