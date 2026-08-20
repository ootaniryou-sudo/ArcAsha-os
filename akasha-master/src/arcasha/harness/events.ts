/**
 * Coding Harness — Event ABI（H0 の最小 event set）
 *
 * Event Stream first: 正式 ABI は AsyncIterable<HarnessEvent>。
 * H2 以降で progress / tool_call / tool_result / model_call / message / cancelled を追加できる。
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

/** H0 の最小 event set。 */
export type HarnessEvent =
  | HarnessStartedEvent
  | HarnessCompletedEvent
  | HarnessFailedEvent;

export function isHarnessStarted(e: HarnessEvent): e is HarnessStartedEvent {
  return e.type === 'started';
}

export function isHarnessTerminal(
  e: HarnessEvent,
): e is HarnessCompletedEvent | HarnessFailedEvent {
  return e.type === 'completed' || e.type === 'failed';
}

/**
 * Event 列の terminal-state を逐次検証する（状態機械）。
 *
 * 不変条件:
 *   - started は 0 または 1 回。terminal より前にのみ出現する
 *   - terminal event（completed / failed）は 0 または 1 回
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
    }
  }
}
