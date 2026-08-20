/**
 * Coding Harness — セルフテスト（H0〜H2-B）
 *
 * 実行: npx tsx src/arcasha/harness/selftest.ts
 *
 * 対象:
 *   H0 — Harness ABI / executeOnce / failure semantics / cancellation / terminal-state
 *   H1 — NativeHarness（決定論コーディングロジックの ABI 実装）
 *   H2-A — DeepSeekHarnessAdapter（version pin / プローブ / Native フォールバック）
 *   H2-B — ACP 実実行（mock ACP サーバー: message 写像 / failed / cancelled / infra）
 */
import type { Harness } from './harness.js';
import type { HarnessEvent } from './events.js';
import { assertTerminalState } from './events.js';
import type {
  HarnessTask,
  HarnessExecuteOptions,
  HarnessExecutionError,
} from './types.js';
import { HarnessInfrastructureError, HarnessTaskError, HarnessCancelledError } from './types.js';
import { executeOnce } from './execute-once.js';
import { consumeHarness } from './consume.js';
import { NativeHarness, generateCode, suggestFunctionName } from './native.js';
import { DeepSeekHarnessAdapter, DSH_VERSION } from './deepseek.js';
import { createHarness, resolveHarness } from './registry.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name} ${detail}`);
  }
}

/** 期待する例外型（コンストラクタ or predicate） */
type ErrorMatcher = (abstract new (...args: never[]) => Error) | ((e: unknown) => boolean);

function matchesError(expected: ErrorMatcher, e: unknown): boolean {
  if (typeof expected === 'function' && expected.prototype instanceof Error) {
    return e instanceof (expected as abstract new (...args: never[]) => Error);
  }
  return (expected as (e: unknown) => boolean)(e);
}

async function expectThrowAsync(
  name: string,
  fn: () => Promise<unknown>,
  expected?: ErrorMatcher,
): Promise<void> {
  try {
    await fn();
    failed++;
    console.error(`  ✗ FAIL: ${name}（例外が投げられなかった）`);
  } catch (e) {
    if (expected && !matchesError(expected, e)) {
      failed++;
      console.error(`  ✗ FAIL: ${name}（期待した例外型ではない: ${(e as Error).constructor?.name}）`);
      return;
    }
    console.log(`  ✓ ${name}（${(e as Error).message}）`);
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── テスト用 Mock Harness ──────────────────────────────────────────────────
type MockMode = 'success' | 'fail' | 'infra' | 'hang' | 'stall';

class MockHarness implements Harness {
  private counter = 0;
  constructor(
    private readonly mode: MockMode,
    private readonly opts: { output?: string; error?: HarnessExecutionError; delayMs?: number } = {},
  ) {}

  async *execute(task: HarnessTask, options?: HarnessExecuteOptions): AsyncIterable<HarnessEvent> {
    const executionId = `mock-${task.taskId}-${++this.counter}`;
    yield { type: 'started', taskId: task.taskId, executionId, timestamp: Date.now() };

    // 即時 abort（signal が最初から aborted）
    if (options?.signal?.aborted) {
      throw new HarnessInfrastructureError('aborted before execution');
    }

    if (this.mode === 'infra') {
      throw new HarnessInfrastructureError('mock infra failure');
    }

    if (this.mode === 'hang') {
      // 協調的: abort を待って throw（delayed abort → infrastructure）
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new HarnessInfrastructureError('aborted during execution');
    }

    if (this.mode === 'stall') {
      // 非協調: abort を無視して永久に待つ（grace period で detach される）
      await new Promise<void>(() => {});
    }

    if (this.opts.delayMs) await delay(this.opts.delayMs);

    if (this.mode === 'fail') {
      yield {
        type: 'failed',
        taskId: task.taskId,
        executionId,
        error: this.opts.error ?? { code: 'TASK_FAIL', message: 'task failed', retryable: true },
        timestamp: Date.now(),
      };
      return;
    }

    yield {
      type: 'completed',
      taskId: task.taskId,
      executionId,
      result: { ok: true, output: this.opts.output ?? 'ok' },
      timestamp: Date.now(),
    };
  }
}

const TASK: HarnessTask = { taskId: 'issue-123', text: 'src/foo.ts のバグを修正してテストを通す' };

/** generator の finally（cleanup）実行を追跡する Harness */
class CleanupTrackingHarness implements Harness {
  cleaned = false;
  async *execute(task: HarnessTask): AsyncIterable<HarnessEvent> {
    try {
      yield { type: 'started', taskId: task.taskId, executionId: 'cleanup-1', timestamp: Date.now() };
      yield { type: 'completed', taskId: task.taskId, executionId: 'cleanup-1', result: { ok: true, output: 'x' }, timestamp: Date.now() };
    } finally {
      this.cleaned = true;
    }
  }
}

// ─── [1] 基本 ABI ────────────────────────────────────────────────────────────
console.log('\n[1] 基本 ABI');
const basic = new MockHarness('success', { output: 'patched' });

const events1: HarnessEvent[] = [];
for await (const e of basic.execute(TASK)) {
  events1.push(e);
}
check('AsyncIterable<HarnessEvent> を逐次観測できる', events1.length === 2);
check('started → completed が成立', events1[0]?.type === 'started' && events1[1]?.type === 'completed');
const completed = events1[1];
check('completed は有効な result を持つ', completed?.type === 'completed' && completed.result.ok && completed.result.output === 'patched');
check('executionId が発行される', typeof completed?.executionId === 'string' && completed.executionId.length > 0);

// 同一 taskId / 別 executionId
const events1b: HarnessEvent[] = [];
for await (const e of basic.execute(TASK)) {
  events1b.push(e);
}
const idA = events1[1]?.executionId;
const idB = events1b[1]?.executionId;
check('同一 taskId で複数 executionId を持てる', idA !== undefined && idB !== undefined && idA !== idB);

// terminal-state 検証（正常系）
check('assertTerminalState: 正常 stream は通る', (() => { try { assertTerminalState(events1); return true; } catch { return false; } })());

// ─── [2] executeOnce ─────────────────────────────────────────────────────────
console.log('\n[2] executeOnce');
const onceOk = await executeOnce(new MockHarness('success', { output: 'ok' }), TASK);
check('success → result', onceOk.ok && onceOk.output === 'ok');

await expectThrowAsync('fail → HarnessTaskError', async () => {
  await executeOnce(new MockHarness('fail'), TASK);
});

// fail の例外型を明示検証（task failure と infra の区別）
{
  let caught: unknown = null;
  try {
    await executeOnce(new MockHarness('fail', { error: { code: 'E', message: 'x', retryable: true } }), TASK);
  } catch (e) {
    caught = e;
  }
  check('fail は HarnessTaskError（task failure）', caught instanceof HarnessTaskError);
  if (caught instanceof HarnessTaskError) {
    check('HarnessTaskError は error 情報を保持', caught.error.code === 'E' && caught.error.retryable === true);
  }
}

await expectThrowAsync('infra → 伝播（HarnessInfrastructureError）', async () => {
  await executeOnce(new MockHarness('infra'), TASK);
}, HarnessInfrastructureError);

// ─── [3] failure semantics ───────────────────────────────────────────────────
console.log('\n[3] failure semantics（failed ≠ throw）');
const failedOutcome = await consumeHarness(new MockHarness('fail', { error: { code: 'TEST_FAIL', message: 'assert failed', retryable: false } }), TASK);
check('failed イベント → status=failed', failedOutcome.status === 'failed');
if (failedOutcome.status === 'failed') {
  check('failed の error に code/message/retryable がある', failedOutcome.error.code === 'TEST_FAIL' && failedOutcome.error.retryable === false);
}

await expectThrowAsync('infrastructure → iterator throw が伝播', async () => {
  await consumeHarness(new MockHarness('infra'), TASK);
}, HarnessInfrastructureError);

// ─── [4] cancellation ────────────────────────────────────────────────────────
console.log('\n[4] cancellation（AbortSignal）');

// 4-1 即時 abort（signal が最初から aborted）
{
  const ac = new AbortController();
  ac.abort();
  await expectThrowAsync('immediate abort → infrastructure throw', async () => {
    await consumeHarness(new MockHarness('success'), TASK, { signal: ac.signal });
  }, HarnessInfrastructureError);
}

// 4-2 delayed abort（協調的 Harness: abort で停止 → throw）
{
  const ac = new AbortController();
  const p = consumeHarness(new MockHarness('hang'), TASK, { signal: ac.signal, cancelGracePeriodMs: 200 });
  await delay(30);
  ac.abort();
  await expectThrowAsync('delayed abort（協調）→ infrastructure throw', async () => {
    await p;
  }, HarnessInfrastructureError);
}

// 4-3 grace period 超過 → detach（非協調 Harness: abort を無視）
{
  const ac = new AbortController();
  const p = consumeHarness(new MockHarness('stall'), TASK, { signal: ac.signal, cancelGracePeriodMs: 100 });
  await delay(20);
  ac.abort();
  const outcome = await p;
  check('grace period 超過 → status=detached', outcome.status === 'detached');
  check('detached は executionId を持つ（started 済み）', outcome.status === 'detached' && outcome.executionId !== null);
}

// 4-4 abort 内の正常完了（grace 内に completed が来れば completed）
{
  const ac = new AbortController();
  const p = consumeHarness(new MockHarness('success', { output: 'in-grace', delayMs: 30 }), TASK, { signal: ac.signal, cancelGracePeriodMs: 500 });
  await delay(10);
  ac.abort();
  const outcome = await p;
  check('grace 内に完了 → status=completed', outcome.status === 'completed' && (outcome.status === 'completed' ? outcome.result.output === 'in-grace' : false));
}

// 4-5 executeOnce への abort 伝播
{
  const ac = new AbortController();
  ac.abort();
  await expectThrowAsync('executeOnce: aborted signal で停止', async () => {
    await executeOnce(new MockHarness('success'), TASK, { signal: ac.signal });
  }, HarnessInfrastructureError);
}

// ─── [5] terminal-state 検証（異常系） ───────────────────────────────────────
console.log('\n[5] terminal-state 検証（異常系）');
const badStartedTwice: HarnessEvent[] = [
  { type: 'started', taskId: 't', executionId: 'e1', timestamp: 1 },
  { type: 'started', taskId: 't', executionId: 'e2', timestamp: 2 },
  { type: 'completed', taskId: 't', executionId: 'e2', result: { ok: true, output: '' }, timestamp: 3 },
];
check('started 複数 → HarnessInfrastructureError', (() => { try { assertTerminalState(badStartedTwice); return false; } catch (e) { return e instanceof HarnessInfrastructureError; } })());

const badTerminalTwice: HarnessEvent[] = [
  { type: 'started', taskId: 't', executionId: 'e', timestamp: 1 },
  { type: 'completed', taskId: 't', executionId: 'e', result: { ok: true, output: '' }, timestamp: 2 },
  { type: 'failed', taskId: 't', executionId: 'e', error: { code: 'X', message: 'x', retryable: true }, timestamp: 3 },
];
check('terminal 複数 → HarnessInfrastructureError', (() => { try { assertTerminalState(badTerminalTwice); return false; } catch (e) { return e instanceof HarnessInfrastructureError; } })());

const badTerminalFirst: HarnessEvent[] = [
  { type: 'completed', taskId: 't', executionId: 'e', result: { ok: true, output: '' }, timestamp: 1 },
];
check('started なしの completed → HarnessInfrastructureError', (() => { try { assertTerminalState(badTerminalFirst); return false; } catch (e) { return e instanceof HarnessInfrastructureError; } })());

// completed → started（順序違反）
const badOrder: HarnessEvent[] = [
  { type: 'started', taskId: 't', executionId: 'e', timestamp: 1 },
  { type: 'completed', taskId: 't', executionId: 'e', result: { ok: true, output: '' }, timestamp: 2 },
  { type: 'started', taskId: 't', executionId: 'e', timestamp: 3 },
];
check('terminal の後の started → HarnessInfrastructureError', (() => { try { assertTerminalState(badOrder); return false; } catch (e) { return e instanceof HarnessInfrastructureError; } })());

// executionId 不一致
const badExecId: HarnessEvent[] = [
  { type: 'started', taskId: 't', executionId: 'e1', timestamp: 1 },
  { type: 'completed', taskId: 't', executionId: 'e2', result: { ok: true, output: '' }, timestamp: 2 },
];
check('executionId 不一致 → HarnessInfrastructureError', (() => { try { assertTerminalState(badExecId); return false; } catch (e) { return e instanceof HarnessInfrastructureError; } })());

// taskId 不一致
const badTaskId: HarnessEvent[] = [
  { type: 'started', taskId: 't1', executionId: 'e', timestamp: 1 },
  { type: 'completed', taskId: 't2', executionId: 'e', result: { ok: true, output: '' }, timestamp: 2 },
];
check('taskId 不一致 → HarnessInfrastructureError', (() => { try { assertTerminalState(badTaskId); return false; } catch (e) { return e instanceof HarnessInfrastructureError; } })());

// executeOnce / consumeHarness: 要求 task と異なる taskId のイベントを拒否
class WrongTaskHarness implements Harness {
  async *execute(_task: HarnessTask): AsyncIterable<HarnessEvent> {
    yield { type: 'started', taskId: 'other-task', executionId: 'e1', timestamp: 1 };
    yield { type: 'completed', taskId: 'other-task', executionId: 'e1', result: { ok: true, output: 'x' }, timestamp: 2 };
  }
}
await expectThrowAsync('executeOnce: 要求 taskId と異なるイベントを拒否', async () => {
  await executeOnce(new WrongTaskHarness(), TASK);
}, HarnessInfrastructureError);
await expectThrowAsync('consumeHarness: 要求 taskId と異なるイベントを拒否', async () => {
  await consumeHarness(new WrongTaskHarness(), TASK);
}, HarnessInfrastructureError);

// ─── [6] 既存 Attachment への非干渉 ──────────────────────────────────────────
console.log('\n[6] 既存 Attachment への非干渉');
// H0 では coding.ts 等の既存 Attachment は変更しない（Harness は独立モジュール）。
// ここでは Harness を未使用でもモジュールが import / 動作することを確認。
const untouched = await executeOnce(new MockHarness('success', { output: 'standalone' }), { taskId: 'no-dep', text: '依存しない' });
check('Harness は単独で動作（既存コードに未依存）', untouched.ok && untouched.output === 'standalone');

// ─── [7] iterator cleanup ────────────────────────────────────────────────────
console.log('\n[7] iterator cleanup');
{
  // consumeHarness 完了時に generator が close され、finally（cleanup）が実行される
  const cleanupHarness = new CleanupTrackingHarness();
  const outcome = await consumeHarness(cleanupHarness, TASK);
  check('完了後に generator が close される（cleanup 実行）', outcome.status === 'completed' && cleanupHarness.cleaned === true);
}
{
  // detached 経路では generator は放置される（close を await してハングしない）
  const ac = new AbortController();
  const p = consumeHarness(new MockHarness('stall'), TASK, { signal: ac.signal, cancelGracePeriodMs: 100 });
  await delay(20);
  ac.abort();
  const outcome = await p;
  check('detached 経路でもハングしない', outcome.status === 'detached');
}
{
  // cleanup の finally が throw しても、結果経路（HarnessOutcome）を置き換えない
  class ThrowCleanupHarness implements Harness {
    async *execute(task: HarnessTask): AsyncIterable<HarnessEvent> {
      try {
        yield { type: 'started', taskId: task.taskId, executionId: 'tc', timestamp: 1 };
        yield { type: 'completed', taskId: task.taskId, executionId: 'tc', result: { ok: true, output: 'x' }, timestamp: 2 };
      } finally {
        // noUnsafeFinally 対策: finally 内の直接 throw を避け、rejected Promise を await する
        await Promise.reject(new Error('cleanup failure'));
      }
    }
  }
  const outcome = await consumeHarness(new ThrowCleanupHarness(), TASK);
  check('cleanup が throw しても completed が返る', outcome.status === 'completed'
    && (outcome.status === 'completed' ? outcome.executionId === 'tc' && outcome.result.output === 'x' : false));
}
{
  // cleanup の finally が無期限に await しても、close はタイムアウトして結果を返す
  class HangCleanupHarness implements Harness {
    async *execute(task: HarnessTask): AsyncIterable<HarnessEvent> {
      try {
        yield { type: 'started', taskId: task.taskId, executionId: 'hc', timestamp: 1 };
        yield { type: 'completed', taskId: task.taskId, executionId: 'hc', result: { ok: true, output: 'x' }, timestamp: 2 };
      } finally {
        await new Promise<void>(() => {});
      }
    }
  }
  const t0 = Date.now();
  const outcome = await consumeHarness(new HangCleanupHarness(), TASK);
  const elapsed = Date.now() - t0;
  check('cleanup がハングしても bounded で completed が返る', outcome.status === 'completed' && elapsed < 5000, `elapsed=${elapsed}ms`);
}

// ─── [8] Native Harness（H1） ────────────────────────────────────────────────
console.log('\n[8] Native Harness（H1）');
{
  const native = new NativeHarness();
  const outcome = await consumeHarness(native, TASK);
  check('NativeHarness: started → completed', outcome.status === 'completed');
  if (outcome.status === 'completed') {
    check('completed は生成コードを output に持つ', outcome.result.output.includes('export function'));
    check('completed は metadata に attempts / functionName を持つ',
      typeof outcome.result.metadata?.attempts === 'number'
      && typeof outcome.result.metadata?.functionName === 'string');
  }
}
{
  // executeOnce 経由でも動作（単発 API との互換）
  const result = await executeOnce(new NativeHarness(), TASK);
  check('executeOnce(NativeHarness) → ok', result.ok && result.output.includes('export function'));
}
{
  // 決定論ヘルパー
  check('suggestFunctionName: 日本語+英語から関数名', suggestFunctionName('バグを修正して solveProblem') === 'solveProblem');
  check('generateCode: 生成コードは export function を含む', generateCode('hello').includes('export function'));
}
{
  // コメント境界（*/）・改行を含むタスク文でも構文が壊れない（サニタイズの回帰検出）
  const outcomeEsc = await consumeHarness(new NativeHarness(), {
    taskId: 'issue-esc',
    text: 'fix */ then\nreturn input',
  });
  check('コメント境界/改行タスクでも completed（サニタイズ）', outcomeEsc.status === 'completed', JSON.stringify(outcomeEsc));

  // 予約語の関数名は solve へフォールバックし、コンパイル可能（回帰検出）
  check('suggestFunctionName: 予約語 → solve', suggestFunctionName('class') === 'solve');
  const outcomeRes = await consumeHarness(new NativeHarness(), { taskId: 'issue-res', text: 'class' });
  check('予約語タスクでも completed（solve フォールバック）', outcomeRes.status === 'completed'
    && (outcomeRes.status === 'completed' ? outcomeRes.result.metadata?.functionName === 'solve' : false));
}
{
  // AbortSignal 伝播（即時 abort → infrastructure throw）
  const ac = new AbortController();
  ac.abort();
  await expectThrowAsync('NativeHarness: 即時 abort → infrastructure throw', async () => {
    await consumeHarness(new NativeHarness(), TASK, { signal: ac.signal });
  }, HarnessInfrastructureError);
}

// ─── [9] DeepSeek Harness Adapter（H2-A） ────────────────────────────────────
console.log('\n[9] DeepSeek Harness Adapter（H2-A）');
{
  check('DSH_VERSION が pin されている', DSH_VERSION.length > 0 && DSH_VERSION === '0.1.0-rc.7');
}
{
  // dsh 不可（probe=false）→ available()=false → execute は infrastructure throw
  const adapter = new DeepSeekHarnessAdapter({ probe: async () => false });
  check('dsh 不可: available()=false', (await adapter.available()) === false);
  await expectThrowAsync('dsh 不可: execute → infrastructure throw', async () => {
    await consumeHarness(adapter, TASK);
  }, HarnessInfrastructureError);
}
{
  // dsh 可（probe=true）だが ACP サーバー未解決（dsh-acp-demo 未インストール）→ infrastructure throw
  const adapter = new DeepSeekHarnessAdapter({ probe: async () => true });
  check('dsh 可: available()=true', (await adapter.available()) === true);
  await expectThrowAsync('dsh 可: ACP サーバー未解決は infrastructure throw', async () => {
    await consumeHarness(adapter, TASK);
  }, HarnessInfrastructureError);
}
{
  // abort で中断された probe はメモ化しない（次回に再プローブさせる）
  let calls = 0;
  const adapter = new DeepSeekHarnessAdapter({
    probe: async (signal) => {
      calls++;
      if (signal?.aborted) return false;
      return true;
    },
  });
  const ac = new AbortController();
  ac.abort();
  check('abort 中 probe: available=false', (await adapter.available(ac.signal)) === false);
  check('abort 中 probe はメモ化されない（再プローブで true）', (await adapter.available()) === true && calls === 2);
}
{
  // Registry: createHarness
  check('createHarness(native) → NativeHarness', createHarness('native') instanceof NativeHarness);
  check('createHarness(deepseek) → DeepSeekHarnessAdapter', createHarness('deepseek') instanceof DeepSeekHarnessAdapter);
}
{
  // Registry: resolveHarness — dsh 不可なら Native にフォールバック（Rollback Safety）
  const resolved = await resolveHarness('deepseek', () => new DeepSeekHarnessAdapter({ probe: async () => false }));
  check('resolveHarness: dsh 不可 → Native フォールバック', resolved instanceof NativeHarness);

  // 選択成功経路: dsh 可 → DeepSeekHarnessAdapter を返す
  const resolvedDsh = await resolveHarness('deepseek', () => new DeepSeekHarnessAdapter({ probe: async () => true }));
  check('resolveHarness: dsh 可 → DeepSeekHarnessAdapter', resolvedDsh instanceof DeepSeekHarnessAdapter);

  // probe 例外（reject）でも Native へフォールバック（例外を伝播しない）
  const resolvedOnThrow = await resolveHarness('deepseek', () => new DeepSeekHarnessAdapter({
    probe: async () => { throw new Error('probe failure'); },
  }));
  check('resolveHarness: probe 例外 → Native フォールバック', resolvedOnThrow instanceof NativeHarness);

  const resolvedNative = await resolveHarness('native');
  check('resolveHarness(native) → NativeHarness', resolvedNative instanceof NativeHarness);
}

// ─── [10] DeepSeek Harness Adapter（H2-B: ACP 実実行） ──────────────────────
console.log('\n[10] DeepSeek Harness Adapter（H2-B: ACP 実実行）');
{
  // mock ACP サーバー（実 ACP ワイヤープロトコル）を子プロセスとして起動する
  const tmp = await mkdtemp(join(tmpdir(), 'arcasha-acp-'));
  const MOCK_SERVER = fileURLToPath(new URL('./mock-acp-server.mjs', import.meta.url));
  const mockAdapter = (
    env: Record<string, string>,
    opts: { permission?: 'allow' | 'reject' } = {},
  ): DeepSeekHarnessAdapter => new DeepSeekHarnessAdapter({
    probe: async () => true,
    permission: opts.permission ?? 'reject',
    requestTimeoutMs: 10_000,
    sessionCwd: tmp,
    serverCommand: () => ({ command: process.execPath, args: [MOCK_SERVER], env }),
  });

  {
    // 正常ターン: started → message → completed（end_turn）
    const adapter = mockAdapter({ MOCK_TEXT: 'hello from dsh', MOCK_STOP: 'end_turn' });
    const events: HarnessEvent[] = [];
    for await (const e of adapter.execute(TASK)) events.push(e);
    assertTerminalState(events);
    const types = events.map((e) => e.type).join('→');
    const texts = events
      .filter((e): e is Extract<HarnessEvent, { type: 'message' }> => e.type === 'message')
      .map((e) => e.text)
      .join('');
    const completed = events.find((e): e is Extract<HarnessEvent, { type: 'completed' }> => e.type === 'completed');
    check('H2-B: started→message→completed の順序', types === 'started→message→completed');
    check('H2-B: message テキスト写像', texts === 'hello from dsh');
    check('H2-B: completed.output が message 連結', completed?.result.output === 'hello from dsh');
  }
  {
    // 正常ターン: consumeHarness でも completed になる
    const adapter = mockAdapter({ MOCK_TEXT: 'ok from acp', MOCK_STOP: 'max_tokens' });
    const outcome = await consumeHarness(adapter, TASK);
    check('H2-B: max_tokens → completed', outcome.status === 'completed' && outcome.result.output === 'ok from acp');
  }
  {
    // refusal → failed（タスク失敗は failed イベント）
    const adapter = mockAdapter({ MOCK_STOP: 'refusal' });
    const outcome = await consumeHarness(adapter, TASK);
    check(
      'H2-B: refusal → failed',
      outcome.status === 'failed' && outcome.error.code === 'REFUSAL' && outcome.error.retryable === false,
    );
  }
  {
    // prompt の RPC エラー（agent 内部エラー）→ infrastructure throw
    const adapter = mockAdapter({ MOCK_FAIL: '1' });
    await expectThrowAsync('H2-B: prompt RPC エラー → infrastructure throw', async () => {
      await consumeHarness(adapter, TASK);
    }, HarnessInfrastructureError);
  }
  {
    // サーバーのクラッシュ → infrastructure throw
    const adapter = mockAdapter({ MOCK_CRASH: '1' });
    await expectThrowAsync('H2-B: サーバークラッシュ → infrastructure throw', async () => {
      await consumeHarness(adapter, TASK);
    }, HarnessInfrastructureError);
  }
  {
    // AbortSignal → session/cancel → cancelled イベント
    const ac = new AbortController();
    const adapter = mockAdapter({ MOCK_HANG: '1' });
    const outcomePromise = consumeHarness(adapter, TASK, { signal: ac.signal, cancelGracePeriodMs: 3_000 });
    setTimeout(() => ac.abort(), 50);
    const outcome = await outcomePromise;
    check('H2-B: abort → cancelled', outcome.status === 'cancelled');
  }
  {
    // executeOnce: cancelled → HarnessCancelledError（cancel ≠ failed）
    const ac = new AbortController();
    const adapter = mockAdapter({ MOCK_HANG: '1' });
    const run = executeOnce(adapter, TASK, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expectThrowAsync('H2-B: executeOnce → HarnessCancelledError', async () => {
      await run;
    }, HarnessCancelledError);
  }
  {
    // 権限要求: reject ポリシー → fail closed → cancelled
    const adapter = mockAdapter({ MOCK_PERMISSION: '1', MOCK_TEXT: 'should not run' }, { permission: 'reject' });
    const outcome = await consumeHarness(adapter, TASK);
    check('H2-B: 権限 reject → cancelled', outcome.status === 'cancelled');
  }
  {
    // 権限要求: allow ポリシー → 最初の allow オプションを選択 → completed
    const adapter = mockAdapter({ MOCK_PERMISSION: '1', MOCK_TEXT: 'approved', MOCK_STOP: 'end_turn' }, { permission: 'allow' });
    const outcome = await consumeHarness(adapter, TASK);
    check('H2-B: 権限 allow → completed', outcome.status === 'completed' && outcome.result.output === 'approved');
  }
  {
    // サーバー未解決（serverCommand=null）→ infrastructure throw（Native フォールバック元）
    const adapter = new DeepSeekHarnessAdapter({ probe: async () => true, serverCommand: () => null });
    await expectThrowAsync('H2-B: サーバー未解決 → infrastructure throw', async () => {
      await consumeHarness(adapter, TASK);
    }, HarnessInfrastructureError);
  }
}

// ─── 結果 ────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — Coding Harness H0');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
