/**
 * DeepSeek Harness Adapter（H2-A スケルトン）— dsh を ACP 経由で接続するアダプタ。
 *
 * ArcAsha Harness ABI
 *        ↓
 * DeepSeekHarnessAdapter
 *        ↓
 * DeepSeek Harness（外部プロセス / ACP）
 *
 * H2-A で実装するもの:
 *   - dsh の固定（lockfile + integrity で解決したローカルパッケージ + 検証済み commit 記録）
 *   - 起動プローブ（available, AbortSignal 伝播）と Native フォールバック
 *   - 失敗の意味論: dsh 不可 = infrastructure failure（iterator throw）
 *
 * H2-B で実装予定:
 *   - ACP サーバーへの接続による実実行
 *   - dsh event（turn/step/tool）→ ArcAsha HarnessEvent の写像
 *   - AbortSignal の ACP キャンセル伝播
 *
 * 注意: dsh 固有の型を ArcAsha 全体へ漏らさない。DSH Event API をそのまま
 * ArcAsha ABI に公開しない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Harness } from './harness.js';
import type { HarnessEvent } from './events.js';
import type { HarnessTask, HarnessExecuteOptions } from './types.js';
import { HarnessInfrastructureError } from './types.js';

/**
 * dsh の固定バージョン（lockfile + integrity で解決。更新は手動レビュー）。
 * §27 の pin 方針に従い、依存は package.json / package-lock.json で宣言し、
 * 実行時は node_modules/.bin/dsh（lockfile 解決済み）を優先する。
 */
export const DSH_VERSION = '0.1.0-rc.7';

/**
 * dsh の検証済み commit SHA（§27: `DSH_COMMIT=<verified-sha>`）。
 * H2-B で ACP 実装と integration test を検証した際に確定し、ここへ記録する。
 */
export const DSH_COMMIT = 'pending-h2b-verification';

/** 起動プローブの上限時間 */
const PROBE_TIMEOUT_MS = 15_000;

/** アダプタの差し替え可能な依存（テスト用） */
export interface DshAdapterOptions {
  /** dsh が実行可能か（AbortSignal を伝播。既定: ローカル lockfile 解決バイナリのみ） */
  probe?: (signal?: AbortSignal) => Promise<boolean>;
  /** コマンド実行（既定: spawn） */
  command?: (cmd: string, args: string[]) => ChildProcess;
}

/**
 * ローカルの dsh バイナリ（akasha-master/node_modules/.bin/dsh）を解決する。
 * lockfile で固定された依存のみを使用する（CWE-829: レジストリからの無審査実行を排除）。
 * 存在しなければ unavailable として扱う。
 */
function localDshBin(): string | null {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/arcasha/harness
  const bin = join(here, '..', '..', '..', 'node_modules', '.bin', 'dsh');
  return existsSync(bin) ? bin : null;
}

/** 既定プローブ: lockfile 解決済みの dsh が起動可能かを `--version` の exit code で判定（AbortSignal 対応） */
async function defaultProbe(
  command: (cmd: string, args: string[]) => ChildProcess,
  signal?: AbortSignal,
): Promise<boolean> {
  const localBin = localDshBin();
  if (!localBin) {
    // ローカルバイナリが無い = 依存未インストール。レジストリ実行（npx）はしない。
    return false;
  }
  return new Promise((resolve) => {
    const child = command(localBin, ['--version']);
    signal?.addEventListener('abort', () => {
      child.kill();
      resolve(false);
    }, { once: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export class DeepSeekHarnessAdapter implements Harness {
  private readonly probe: (signal?: AbortSignal) => Promise<boolean>;
  private probeResult: boolean | null = null;

  constructor(opts: DshAdapterOptions = {}) {
    const command = opts.command ?? ((cmd: string, args: string[]) => spawn(cmd, args, { stdio: 'ignore' }));
    this.probe = opts.probe ?? ((signal) => defaultProbe(command, signal));
  }

  /**
   * dsh が利用可能か。不可なら呼び出し側は Native へフォールバックしてよい。
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

    // dsh が起動できない = infrastructure failure（iterator throw）
    if (!(await this.available(options?.signal))) {
      throw new HarnessInfrastructureError(`DeepSeek Harness を起動できません（DSH v${DSH_VERSION} unavailable）`);
    }
    if (options?.signal?.aborted) {
      throw new HarnessInfrastructureError('aborted during probe');
    }

    // H2-B で ACP 実行を実装するまで、available なのに実行できない状態は
    // ABI 不整合 = infrastructure failure として throw する。
    throw new HarnessInfrastructureError('DSH ACP 実行は H2-B で実装予定（adapter skeleton）');
  }
}
