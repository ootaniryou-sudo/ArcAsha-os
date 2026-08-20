/**
 * DeepSeek Harness Adapter（H2-B）— dsh を ACP 経由で接続するアダプタ。
 *
 * ArcAsha Harness ABI
 *        ↓
 * DeepSeekHarnessAdapter
 *        ↓
 * DeepSeek Harness（外部プロセス / ACP）
 *
 * H2-A で実装済み:
 *   - dsh の固定（lockfile + integrity で解決したローカルパッケージ + 検証済み commit 記録）
 *   - 起動プローブ（available, AbortSignal 伝播）と Native フォールバック
 *   - 失敗の意味論: dsh 不可 = infrastructure failure（iterator throw）
 *
 * H2-B で実装済み:
 *   - ACP サーバーへの接続による実実行（initialize → session/new → session/prompt）
 *   - ACP session update（agent_message_chunk）→ ArcAsha HarnessEvent（message）の写像
 *   - AbortSignal → ACP session/cancel の伝播（cancelled イベント）
 *   - stopReason → completed / failed / cancelled の写像
 *
 * 注意: dsh 固有の型を ArcAsha 全体へ漏らさない。ACP / dsh の型は acp.ts 内に閉じ込める。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Harness } from './harness.js';
import type { HarnessEvent } from './events.js';
import type { HarnessTask, HarnessExecuteOptions } from './types.js';
import { HarnessInfrastructureError } from './types.js';
import { AcpClient, type AcpServerSpec } from './acp.js';

/**
 * dsh の固定バージョン（lockfile + integrity で解決。更新は手動レビュー）。
 * §27 の pin 方針に従い、依存は package.json / package-lock.json で宣言し、
 * 実行時は node_modules/.bin（lockfile 解決済み）を優先する。
 */
export const DSH_VERSION = '0.1.0-rc.7';

/** ACP サーバー（@deepseek-ai/dsh-acp-demo）の固定バージョン（lockfile で解決）。 */
export const ACP_DEMO_VERSION = '0.1.0-rc.8';

/**
 * dsh の検証済み commit SHA（§27: `DSH_COMMIT=<verified-sha>`）。
 * H2-B では ACP ワイヤープロトコルを mock ACP サーバーで検証済み。
 * 実 dsh（dsh-acp-demo）の integration test で検証した際に確定し、ここへ記録する。
 */
export const DSH_COMMIT = 'pending-h2b-verification';

/** 起動プローブの上限時間 */
const PROBE_TIMEOUT_MS = 10_000;

/** アダプタの差し替え可能な依存（テスト用） */
export interface DshAdapterOptions {
  /**
   * dsh ACP サーバーが利用可能か（AbortSignal を伝播）。
   * 既定: サーバーを実際に起動して initialize できるかを確認（未設定なら false → Native フォールバック）。
   */
  probe?: (signal?: AbortSignal) => Promise<boolean>;
  /**
   * ACP サーバーの起動コマンド。既定: ローカル node_modules/.bin/dsh-acp-demo（lockfile 固定）。
   * 未解決なら null を返し、実行は infrastructure failure になる（Native フォールバック）。
   */
  serverCommand?: () => AcpServerSpec | null;
  /** セッションの作業ディレクトリ（session/new へ渡す絶対パス）。既定: process.cwd()。 */
  sessionCwd?: string;
  /** 権限要求の自動応答ポリシー（既定: reject = fail closed）。 */
  permission?: 'allow' | 'reject';
  /** ACP リクエストのタイムアウト（ms）。 */
  requestTimeoutMs?: number;
}

/**
 * ローカルの ACP サーバー bin（akasha-master/node_modules/.bin/dsh-acp-demo）を解決する。
 * @deepseek-ai/dsh-acp-demo は bin `dsh-acp-demo` を提供し、package-lock.json（lockfile）で固定する
 * （CWE-829: レジストリからの無審査実行を排除）。存在しなければ null。
 */
function localAcpServerBin(): string | null {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/arcasha/harness
  const bin = join(here, '..', '..', '..', 'node_modules', '.bin', 'dsh-acp-demo');
  return existsSync(bin) ? bin : null;
}

/** 既定の ACP サーバー起動コマンド。 */
function defaultServerCommand(): AcpServerSpec | null {
  const bin = localAcpServerBin();
  return bin === null ? null : { command: bin };
}

/**
 * 既定プローブ: ACP サーバーを実際に起動し initialize できるかを確認する。
 * 未導入・未設定（cordis.yml 欠落）なら false → 呼び出し側は Native へフォールバック。
 */
async function defaultProbe(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const server = defaultServerCommand();
  if (server === null) return false;
  let client: AcpClient | null = null;
  try {
    client = await AcpClient.connect({
      server,
      sessionCwd: process.cwd(),
      permission: 'reject',
      requestTimeoutMs: PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export class DeepSeekHarnessAdapter implements Harness {
  private readonly probe: (signal?: AbortSignal) => Promise<boolean>;
  private readonly serverCommand: () => AcpServerSpec | null;
  private readonly sessionCwd: string;
  private readonly permission: 'allow' | 'reject';
  private readonly requestTimeoutMs?: number;
  private probeResult: boolean | null = null;

  constructor(opts: DshAdapterOptions = {}) {
    this.probe = opts.probe ?? defaultProbe;
    this.serverCommand = opts.serverCommand ?? defaultServerCommand;
    this.sessionCwd = opts.sessionCwd ?? process.cwd();
    this.permission = opts.permission ?? 'reject';
    this.requestTimeoutMs = opts.requestTimeoutMs;
  }

  /**
   * dsh ACP サーバーが利用可能か。不可なら呼び出し側は Native へフォールバックしてよい。
   * 成功した probe 結果のみインスタンス単位でメモ化（二重 probe を防止）。
   * abort で中断された結果はメモ化しない（次回に再プローブさせる）。
   */
  async available(signal?: AbortSignal): Promise<boolean> {
    if (this.probeResult !== null) return this.probeResult;
    const result = await this.probe(signal);
    if (!signal?.aborted) {
      this.probeResult = result;
    }
    return result;
  }

  async *execute(task: HarnessTask, options?: HarnessExecuteOptions): AsyncIterable<HarnessEvent> {
    const executionId = `dsh-${task.taskId}-${Date.now()}`;
    yield { type: 'started', taskId: task.taskId, executionId, timestamp: Date.now() };

    if (options?.signal?.aborted) {
      throw new HarnessInfrastructureError('aborted before execution');
    }

    // dsh（ACP サーバー）が利用できない = infrastructure failure（iterator throw）
    if (!(await this.available(options?.signal))) {
      throw new HarnessInfrastructureError(`DeepSeek Harness ACP サーバーを起動できません（DSH v${DSH_VERSION} unavailable）`);
    }
    if (options?.signal?.aborted) {
      throw new HarnessInfrastructureError('aborted during probe');
    }

    const server = this.serverCommand();
    if (server === null) {
      throw new HarnessInfrastructureError('DSH ACP サーバーが解決できません（dsh-acp-demo 未インストール）');
    }

    const ac = options?.signal;
    let client: AcpClient | null = null;
    let abortCloseTimer: ReturnType<typeof setTimeout> | undefined;

    // AbortSignal → ACP session/cancel の伝播。
    // さらに協力的でない子プロセスへの保険として、猶予後に強制終了する
    // （generator が consumeHarness から detach されてもプロセスを leak させない）。
    const onAbort = (): void => {
      client?.cancel();
      abortCloseTimer = setTimeout(() => {
        void client?.close().catch(() => undefined);
      }, ABORT_CLOSE_GRACE_MS);
    };
    ac?.addEventListener('abort', onAbort, { once: true });

    try {
      client = await AcpClient.connect({
        server,
        sessionCwd: this.sessionCwd,
        permission: this.permission,
        requestTimeoutMs: this.requestTimeoutMs,
        onStderr: (line) => console.error(`[dsh-acp] ${line}`),
      });
      if (ac?.aborted) {
        // 起動中（プローブ / initialize / newSession 前）に abort → 作業は開始していない。
        // session/cancel 不要で、cleanup 後に cancelled を返す（cancel ≠ failed）。
        yield { type: 'cancelled', taskId: task.taskId, executionId, reason: 'aborted during ACP startup', timestamp: Date.now() };
        return;
      }
      await client.newSession();
      if (ac?.aborted) {
        // セッション作成直後に abort → プロンプトを開始せず cancelled
        yield { type: 'cancelled', taskId: task.taskId, executionId, reason: 'aborted before prompt', timestamp: Date.now() };
        return;
      }

      // 以後 client は非 null。クロージャ内で使うため const に固定する。
      const acp: AcpClient = client;

      // agent_message_chunk は内部キューに溜まり、nextMessage() で読み出せる。
      // prompt の settle（成功 / 失敗 / キャンセル）時に endMessages() でキューを
      // 終端し、待機中の nextMessage() を done:true で解放する（レース / チャンク消失を防止）。
      const promptP = acp.prompt(task.text).then(
        (response) => {
          acp.endMessages();
          return { ok: true as const, response };
        },
        (error) => {
          acp.endMessages();
          return { ok: false as const, error };
        },
      );

      const chunks: string[] = [];
      // ループ: キューを最後まで読み、各チャンクを message イベントとして yield する。
      // キュー終端 = prompt 完了 or 子プロセス終了（AcpClient が end() を呼ぶ）。
      for (;;) {
        const v = await acp.nextMessage();
        if (v.done) break;
        chunks.push(v.value);
        yield { type: 'message', taskId: task.taskId, executionId, text: v.value, timestamp: Date.now() };
      }
      // prompt 完了直前に届いていた残りを掃き出す（順序保証の保険）
      for (;;) {
        const tail = acp.tryNextMessage();
        if (tail === null) break;
        chunks.push(tail);
        yield { type: 'message', taskId: task.taskId, executionId, text: tail, timestamp: Date.now() };
      }

      // ── prompt 完了 ──
      const settled = await promptP;
      if (!settled.ok) {
        // AcpClient は既に HarnessInfrastructureError へ正規化済み
        throw settled.error;
      }
      // ACP 型を漏らさないため stopReason は string として扱う
      const stop: string = settled.response.stopReason;
      if (stop === 'cancelled') {
        yield { type: 'cancelled', taskId: task.taskId, executionId, reason: 'ACP session/cancel', timestamp: Date.now() };
      } else if (stop === 'end_turn' || stop === 'max_tokens' || stop === 'max_turn_requests') {
        yield {
          type: 'completed',
          taskId: task.taskId,
          executionId,
          result: { ok: true, output: chunks.join('') },
          timestamp: Date.now(),
        };
      } else if (stop === 'refusal') {
        yield {
          type: 'failed',
          taskId: task.taskId,
          executionId,
          error: { code: 'REFUSAL', message: 'モデルが応答を拒否しました', retryable: false },
          timestamp: Date.now(),
        };
      } else {
        yield {
          type: 'failed',
          taskId: task.taskId,
          executionId,
          error: { code: `STOP_${stop.toUpperCase()}`, message: `未対応の stopReason: ${stop}`, retryable: false },
          timestamp: Date.now(),
        };
      }
    } finally {
      ac?.removeEventListener('abort', onAbort);
      if (abortCloseTimer !== undefined) clearTimeout(abortCloseTimer);
      await client?.close().catch(() => undefined);
    }
  }
}

/** abort 後に子プロセスを強制終了するまでの猶予（ms）。 */
const ABORT_CLOSE_GRACE_MS = 5_000;
