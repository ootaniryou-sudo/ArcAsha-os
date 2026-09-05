/**
 * Sandbox Runner — run_command を隔離実行するためのインタフェース（拡張点）
 *
 * 現状の run_command は child_process.spawn でリポジトリ root を cwd に実行する
 * （opt-in でのみ有効）。ここでは、将来 Docker / Firecracker 等のサンドボックスへ
 * 委譲するための共通インタフェースを定義する。
 *
 * 既定の実装は「安全な直接実行」（allowRunCommand=true のときのみ・タイムアウト付き）。
 * 環境変数 ARCASHA_SANDBOX=container を設定すると、run_command はこのインタフェースを
 * 通して隔離コンテナで実行される想定（実装はホスト依存のためプラグイン点）。
 */

/** サンドボックス実行のオプション。 */
export interface SandboxRunOptions {
  /** 実行コマンド（引数分離 or shell 文字列）。 */
  command: string;
  /** 作業ディレクトリ（リポジトリ root 相対 or 絶対）。 */
  cwd: string;
  /** タイムアウト（ms）。 */
  timeoutMs: number;
  /** ネットワークアクセスを許可するか（既定 false = 遮断）。 */
  allowNetwork?: boolean;
  /** 読み取り専用マウントにするか（既定 false = 書き込み可）。 */
  readOnly?: boolean;
}

/** サンドボックス実行の結果。 */
export interface SandboxRunResult {
  ok: boolean;
  output: string;
  ms: number;
}

/** サンドボックスランナー（プラグイン点）。 */
export interface SandboxRunner {
  readonly id: string;
  /** コマンドを隔離実行する。 */
  run(opts: SandboxRunOptions): Promise<SandboxRunResult>;
  /** このランナーが利用可能か（Docker 等の存在確認）。 */
  available(): Promise<boolean>;
}

/**
 * 既定のサンドボックスランナー = 制限付き直接実行。
 * ネットワーク遮断・読み取り専用は子プロセス単体では完全には強制できないため、
 * ホスト側の権限（env ARCASHA_AGENT_ALLOW_RUN）とタイムアウトで安全性を担保する。
 * より強力な隔離は container ランナー（Docker 等）を別途実装する。
 */
export class DirectSandboxRunner implements SandboxRunner {
  readonly id = 'direct';
  /** 収集する最大出力（バイト）。超過時は子プロセスを終了して切り詰める（メモリ保護）。 */
  static readonly MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB
  private readonly spawnImpl: (
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; error?: string }>;

  constructor(
    spawnImpl?: (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<{
      code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; error?: string;
    }>,
  ) {
    // テストで差し替え可能にしておく
    this.spawnImpl = spawnImpl ?? (async (command, args, cwd, timeoutMs) => {
      const { spawn } = await import('node:child_process');
      return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        // 出力が上限を超えたら子プロセスを終了する（無制限出力コマンドのメモリ枯渇を防ぐ）
        const killIfOverflow = (): void => {
          if (settled) return;
          if (stdout.length + stderr.length > DirectSandboxRunner.MAX_OUTPUT_BYTES) {
            settled = true;
            child.kill('SIGKILL');
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr, timedOut: false, truncated: true });
          }
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          resolve({ code: null, stdout, stderr, timedOut: true, truncated: false });
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); killIfOverflow(); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); killIfOverflow(); });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: null, stdout, stderr, timedOut: false, truncated: false, error: err.message });
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut: false, truncated: false });
        });
      });
    });
  }

  async available(): Promise<boolean> {
    return true;
  }

  async run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
    const t0 = Date.now();
    // shell:false のため、コマンドを引数に分割して直接実行（シェルインジェクション防止）
    const parts = opts.command.trim().split(/\s+/);
    const [cmd, ...args] = parts;
    if (!cmd) {
      return { ok: false, output: 'コマンドが空です', ms: Date.now() - t0 };
    }
    const out = await this.spawnImpl(cmd, args, opts.cwd, opts.timeoutMs);
    if (out.timedOut) {
      return { ok: false, output: `[タイムアウト ${Math.floor(opts.timeoutMs / 1000)}s]`, ms: Date.now() - t0 };
    }
    if (out.truncated) {
      return { ok: false, output: `[出力上限 ${Math.floor(DirectSandboxRunner.MAX_OUTPUT_BYTES / 1024)}KiB 超過] コマンドを終了しました`, ms: Date.now() - t0 };
    }
    if (out.error !== undefined) {
      return { ok: false, output: `起動失敗: ${out.error}`, ms: Date.now() - t0 };
    }
    const body = `${out.stdout}${out.stderr ? `\n--- stderr ---\n${out.stderr}` : ''}`.trim();
    return {
      ok: out.code === 0,
      output: `[exit code ${out.code}]（${Date.now() - t0}ms）\n${body}`,
      ms: Date.now() - t0,
    };
  }
}

/**
 * 設定に応じたサンドボックスランナーを返す。
 * env ARCASHA_SANDBOX=direct（既定）/ container（未実装は direct にフォールバック）。
 */
export function getSandboxRunner(): SandboxRunner {
  const mode = (process.env.ARCASHA_SANDBOX ?? 'direct').toLowerCase();
  if (mode === 'container') {
    // コンテナサンドボックスはホスト依存のため、現状は direct にフォールバックし、
    // 将来ここで Docker ランナーを返す（実装プラグイン点）。
    console.warn('⚠️ ARCASHA_SANDBOX=container は未実装のため direct にフォールバックします');
  }
  return new DirectSandboxRunner();
}
