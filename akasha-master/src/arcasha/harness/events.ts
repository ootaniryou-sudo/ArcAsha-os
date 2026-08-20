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
 * Event 列の terminal-state を検証する。
 *
 * 不変条件:
 *   - started は 0 または 1 回
 *   - terminal event（completed / failed）は 0 または 1 回
 *   - terminal event は started の後にのみ出現する
 *
 * 違反は ABI 不整合 = infrastructure failure として HarnessInfrastructureError。
 */
export function assertTerminalState(events: readonly HarnessEvent[]): void {
  let started = 0;
  let terminals = 0;
  for (const e of events) {
    if (e.type === 'started') started++;
    if (isHarnessTerminal(e)) terminals++;
  }
  if (started > 1) {
    throw new HarnessInfrastructureError(`started が複数回: ${started}`);
  }
  if (terminals > 1) {
    throw new HarnessInfrastructureError(`terminal event が複数回: ${terminals}`);
  }
  if (terminals === 1 && started === 0) {
    throw new HarnessInfrastructureError('terminal event が started より先に出現');
  }
}
