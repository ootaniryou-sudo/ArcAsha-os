/**
 * Coding Harness — Event ABI
 *
 * Event Stream first: 正式 ABI は AsyncIterable<HarnessEvent>。
 *
 * H0: started / completed / failed
 * H2-B: message（中間テキスト）/ cancelled（明示的キャンセル）を追加。
 */
import type { HarnessResult, HarnessExecutionError } from './types.js';
import { HarnessInfrastructureError } from './types.js';

/** 実行開始。 */
export interface HarnessStartedEvent {
  type: 'started';
  taskId: string;
  executionId: string;
  timestamp: number;
}

/** 正常完了。completed 発行時点で result は有効な最終結果。 */
export interface HarnessCompletedEvent {
  type: 'completed';
  taskId: string;
  executionId: string;
  result: HarnessResult;
  timestamp: number;
}

/** タスク失敗。Harness は存続可能。 */
export interface HarnessFailedEvent {
  type: 'failed';
  taskId: string;
  executionId: string;
  error: HarnessExecutionError;
  timestamp: number;
}

/** 実行中の中間メッセージ（assistant テキスト断片など）。非終端。 */
export interface HarnessMessageEvent {
  type: 'message';
  taskId: string;
  executionId: string;
  text: string;
  timestamp: number;
}

/** 明示的キャンセル（AbortSignal → 下位実行の停止確認）。終端イベント。cancel ≠ failed。 */
export interface HarnessCancelledEvent {
  type: 'cancelled';
  taskId: string;
  executionId: string;
  reason: string;
  timestamp: number;
}

/** Harness の event set。 */
export type HarnessEvent =
  | HarnessStartedEvent
  | HarnessCompletedEvent
  | HarnessFailedEvent
  | HarnessMessageEvent
  | HarnessCancelledEvent;

export function isHarnessStarted(e: HarnessEvent): e is HarnessStartedEvent {
  return e.type === 'started';
}

/** 終端イベント（completed / failed / cancelled）。 */
export function isHarnessTerminal(
  e: HarnessEvent,
): e is HarnessCompletedEvent | HarnessFailedEvent | HarnessCancelledEvent {
  return e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled';
}

/**
 * Event 列の terminal-state を逐次検証する（状態機械）。
 *
 * 不変条件:
 *   - started は 0 または 1 回。terminal より前にのみ出現する
 *   - terminal event（completed / failed / cancelled）は 0 または 1 回
 *   - 非終端 event（started / message）は terminal の後に出現しない
 *   - 全イベントの taskId / executionId が一致する
 *
 * 違反は ABI 不整合 = infrastructure failure として HarnessInfrastructureError。
 */
export function assertTerminalState(events: readonly HarnessEvent[]): void {
  let started = 0;
  let terminals = 0;
  let taskId: string | null = null;
  let executionId: string | null = null;

  for (const e of events) {
    // ID 一致（全イベントが同一 task / execution を指す）
    if (taskId === null) {
      taskId = e.taskId;
    } else if (taskId !== e.taskId) {
      throw new HarnessInfrastructureError(`taskId 不一致: ${taskId} ≠ ${e.taskId}`);
    }
    if (executionId === null) {
      executionId = e.executionId;
    } else if (executionId !== e.executionId) {
      throw new HarnessInfrastructureError(`executionId 不一致: ${executionId} ≠ ${e.executionId}`);
    }

    if (e.type === 'started') {
      started++;
      if (started > 1) {
        throw new HarnessInfrastructureError(`started が複数回: ${started}`);
      }
      if (terminals > 0) {
        throw new HarnessInfrastructureError('started が terminal の後に出現');
      }
    } else if (isHarnessTerminal(e)) {
      terminals++;
      if (terminals > 1) {
        throw new HarnessInfrastructureError(`terminal event が複数回: ${terminals}`);
      }
      if (started === 0) {
        throw new HarnessInfrastructureError('terminal event が started より先に出現');
      }
    } else if (terminals > 0) {
      // 非終端 event（message など）が terminal の後に出現 = ABI 違反
      throw new HarnessInfrastructureError(`非終端 event（${e.type}）が terminal の後に出現`);
    } else if (started === 0) {
      // 非終端 event（message など）が started より前に出現 = ABI 違反
      throw new HarnessInfrastructureError(`非終端 event（${e.type}）が started より前に出現`);
    }
  }
}
