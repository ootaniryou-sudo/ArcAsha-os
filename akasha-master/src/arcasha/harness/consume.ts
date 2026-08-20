/**
 * Coding Harness — consumeHarness（Event Stream 消費 + 分類）
 *
 * Harness を最後まで消費し、結果を HarnessOutcome に分類する。
 * Cancellation と detach の意味論を H0 の範囲で具体化する:
 *
 *   - AbortSignal 発火後、cancelGracePeriodMs だけ terminal event を待つ。
 *   - grace period 内に terminal event が来れば completed / failed。
 *   - 超過したら detached を返す（呼び出し側が execution を切り離す）。
 *     detached は「副作用が存在しない」ことを意味しない。H0 では rollback しない。
 *   - iterator throw（infrastructure failure）はそのまま伝播する。
 */
import type { Harness } from './harness.js';
import type {
  HarnessTask,
  HarnessExecuteOptions,
  HarnessResult,
  HarnessExecutionError,
} from './types.js';
import { HarnessInfrastructureError } from './types.js';
import type { HarnessEvent } from './events.js';

/** 実行結果の分類。 */
export type HarnessOutcome =
  | { status: 'completed'; executionId: string; result: HarnessResult }
  | { status: 'failed'; executionId: string; error: HarnessExecutionError }
  | { status: 'detached'; executionId: string | null; reason: string };

const DEFAULT_GRACE_MS = 3000;

export async function consumeHarness(
  harness: Harness,
  task: HarnessTask,
  options?: HarnessExecuteOptions,
): Promise<HarnessOutcome> {
  const cancelGracePeriodMs = options?.cancelGracePeriodMs ?? DEFAULT_GRACE_MS;
  const signal = options?.signal;
  let executionId: string | null = null;

  const iterator = harness.execute(task, options)[Symbol.asyncIterator]();

  // abort を待つ Promise（signal なし・未発火なら決して resolve しない）
  const aborted = new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

  // abort 後に grace period だけ待って detached マーカーを返す
  const detachedMarker = async (): Promise<{ readonly __detached: true }> => {
    await new Promise((r) => setTimeout(r, cancelGracePeriodMs));
    return { __detached: true };
  };

  for (;;) {
    // 次のイベントを待つ。ただし abort されたら grace period と競わせる。
    const res = await Promise.race([
      iterator.next(),
      aborted.then(() => detachedMarker()),
    ]);

    if ('__detached' in res) {
      return {
        status: 'detached',
        executionId,
        reason: `abort 後 ${cancelGracePeriodMs}ms 以内に terminal event が無い`,
      };
    }
    if (res.done) {
      // 正常終了したのに terminal event が無い = ABI 違反（infrastructure failure）
      throw new HarnessInfrastructureError('Harness が terminal event なしに終了');
    }
    const event: HarnessEvent = res.value;
    executionId = event.executionId;
    if (event.type === 'completed') {
      return { status: 'completed', executionId, result: event.result };
    }
    if (event.type === 'failed') {
      return { status: 'failed', executionId, error: event.error };
    }
    // started → 次のイベントへ
  }
  // NOTE: detached 時、下位イテレータは放置される（H0 では rollback 保証なし）。
}
