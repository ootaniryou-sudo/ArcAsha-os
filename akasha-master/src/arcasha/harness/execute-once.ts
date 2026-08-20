/**
 * Coding Harness — executeOnce（単発 API）
 *
 * Event Stream の上に実装する単発 API。
 *   - completed → result を返す
 *   - failed   → HarnessTaskError を throw（task failure）
 *   - terminal event なしに終了 / started なしの terminal → HarnessInfrastructureError
 *   - iterator throw → そのまま伝播（infrastructure failure）
 */
import type { Harness } from './harness.js';
import type { HarnessTask, HarnessExecuteOptions, HarnessResult } from './types.js';
import { HarnessTaskError, HarnessInfrastructureError } from './types.js';

export async function executeOnce(
  harness: Harness,
  task: HarnessTask,
  options?: HarnessExecuteOptions,
): Promise<HarnessResult> {
  let sawStarted = false;
  let executionId: string | null = null;
  for await (const event of harness.execute(task, options)) {
    // 要求 task との一致を検証（壊れた Adapter が別タスクの結果を返すのを拒否）
    if (event.taskId !== task.taskId) {
      throw new HarnessInfrastructureError(`event taskId 不一致: 要求=${task.taskId} 受信=${event.taskId}`);
    }

    if (event.type === 'started') {
      if (sawStarted) throw new HarnessInfrastructureError('started が複数回');
      sawStarted = true;
      executionId = event.executionId;
      continue;
    }
    // terminal 系
    if (!sawStarted) {
      throw new HarnessInfrastructureError('terminal event が started より先に出現');
    }
    if (executionId !== null && event.executionId !== executionId) {
      throw new HarnessInfrastructureError(`executionId 不一致: ${executionId} ≠ ${event.executionId}`);
    }
    if (event.type === 'completed') {
      return event.result;
    }
    if (event.type === 'failed') {
      throw new HarnessTaskError(event.error);
    }
  }
  throw new HarnessInfrastructureError('Harness が terminal event なしに終了');
}
