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
 *   - dsh のバージョン pin（developer preview のため手動レビューで更新）
 *   - 起動プローブ（available）と Native フォールバック
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
import type { Harness } from './harness.js';
import type { HarnessEvent } from './events.js';
import type { HarnessTask, HarnessExecuteOptions } from './types.js';
import { HarnessInfrastructureError } from './types.js';

/** dsh の固定バージョン（commit pin）。更新は手動レビュー + integration test で検証。 */
export const DSH_VERSION = '0.1.0-rc.7';

/** 起動プローブの上限時間 */
const PROBE_TIMEOUT_MS = 15_000;

/** アダプタの差し替え可能な依存（テスト用） */
export interface DshAdapterOptions {
  /** dsh が実行可能か（既定: `npx --yes @deepseek-ai/dsh@<pin> --version`） */
  probe?: () => Promise<boolean>;
  /** コマンド実行（既定: npx を spawn） */
  command?: (args: string[]) => ChildProcess;
}

/** 既定プローブ: pin した dsh が起動可能かを `--version` の exit code で判定 */
async function defaultProbe(command: (args: string[]) => ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const child = command(['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`, '--version']);
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
  private readonly probe: () => Promise<boolean>;

  constructor(opts: DshAdapterOptions = {}) {
    const command = opts.command ?? ((args: string[]) => spawn('npx', args, { stdio: 'ignore' }));
    this.probe = opts.probe ?? (() => defaultProbe(command));
  }

  /** dsh が利用可能か。不可なら呼び出し側は Native へフォールバックしてよい。 */
  async available(): Promise<boolean> {
    return this.probe();
  }

  async *execute(task: HarnessTask, options?: HarnessExecuteOptions): AsyncIterable<HarnessEvent> {
    const executionId = `dsh-${task.taskId}-${Date.now()}`;
    yield { type: 'started', taskId: task.taskId, executionId, timestamp: Date.now() };

    if (options?.signal?.aborted) {
      throw new HarnessInfrastructureError('aborted before execution');
    }

    // dsh が起動できない = infrastructure failure（iterator throw）
    if (!(await this.available())) {
      throw new HarnessInfrastructureError(`DeepSeek Harness を起動できません（DSH v${DSH_VERSION} unavailable）`);
    }

    // H2-B で ACP 実行を実装するまで、available なのに実行できない状態は
    // ABI 不整合 = infrastructure failure として throw する。
    throw new HarnessInfrastructureError('DSH ACP 実行は H2-B で実装予定（adapter skeleton）');
  }
}
