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
  for await (const event of harness.execute(task, options)) {
    if (event.type === 'started') {
      sawStarted = true;
      continue;
    }
    if (event.type === 'completed') {
      if (!sawStarted) {
        throw new HarnessInfrastructureError('completed が started より先に出現');
      }
      return event.result;
    }
    if (event.type === 'failed') {
      if (!sawStarted) {
        throw new HarnessInfrastructureError('failed が started より先に出現');
      }
      throw new HarnessTaskError(event.error);
    }
  }
  throw new HarnessInfrastructureError('Harness が terminal event なしに終了');
}
