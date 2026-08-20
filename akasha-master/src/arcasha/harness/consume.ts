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

/** generator close（iterator.return）の上限時間。cleanup が無期限に settle しない場合の保険。 */
const CLOSE_TIMEOUT_MS = 1000;

export async function consumeHarness(
  harness: Harness,
  task: HarnessTask,
  options?: HarnessExecuteOptions,
): Promise<HarnessOutcome> {
  const cancelGracePeriodMs = options?.cancelGracePeriodMs ?? DEFAULT_GRACE_MS;
  const signal = options?.signal;
  let executionId: string | null = null;
  let sawStarted = false;

  const iterator = harness.execute(task, options)[Symbol.asyncIterator]();

  // abort 時に 1 回だけ作成される grace period deadline。
  // 以降の iterator.next() との race すべてで同じ deadline を再利用する
  // （started / 将来の progress イベントで期限が延長されないようにする）。
  const abortDeadline = new Promise<{ readonly __detached: true }>((resolve) => {
    if (!signal) return; // signal なし → 決して resolve しない
    const start = (): void => {
      void new Promise((r) => setTimeout(r, cancelGracePeriodMs)).then(() =>
        resolve({ __detached: true }),
      );
    };
    if (signal.aborted) start();
    else signal.addEventListener('abort', () => start(), { once: true });
  });

  let skipClose = false;
  try {
    for (;;) {
      // 次のイベントを待つ。abort されたら grace deadline と競わせる。
      const res = await Promise.race([iterator.next(), abortDeadline]);

      if ('__detached' in res) {
        // detached: 下位イテレータは放置する（H0 では rollback / cleanup 保証なし）
        skipClose = true;
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

      // ── 逐次状態機械: 順序・重複・ID 一致を検証（壊れた Adapter からの防御） ──
      if (event.taskId !== task.taskId) {
        throw new HarnessInfrastructureError(`event taskId 不一致: 要求=${task.taskId} 受信=${event.taskId}`);
      }
      if (executionId === null) {
        executionId = event.executionId;
      } else if (event.executionId !== executionId) {
        throw new HarnessInfrastructureError(`executionId 不一致: ${executionId} ≠ ${event.executionId}`);
      }

      if (event.type === 'started') {
        if (sawStarted) throw new HarnessInfrastructureError('started が複数回');
        sawStarted = true;
        continue;
      }
      // terminal 系
      if (!sawStarted) {
        throw new HarnessInfrastructureError('terminal event が started より先に出現');
      }
      if (event.type === 'completed') {
        return { status: 'completed', executionId, result: event.result };
      }
      if (event.type === 'failed') {
        return { status: 'failed', executionId, error: event.error };
      }
    }
  } finally {
    // 非 detached の経路では AsyncGenerator を close し、finally / リソース解放を実行する。
    // cleanup の失敗（reject）や無期限停止を結果経路（HarnessOutcome / 元の例外）に
    // 伝播させない: 失敗は握りつぶし、close には上限時間を設ける。
    if (!skipClose) {
      // close の失敗（reject）は握りつぶし、タイムアウトは race 完了後に必ず解除する
      // （iterator.return() が即時完了しても event loop を CLOSE_TIMEOUT_MS 保持しない）。
      let closeTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve()
            .then(() => iterator.return?.())
            .catch(() => undefined),
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(resolve, CLOSE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (closeTimeout !== undefined) clearTimeout(closeTimeout);
      }
    }
  }
}
