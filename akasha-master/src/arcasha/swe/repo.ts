/**
 * SWE-bench 評価用の git 操作ユーティリティ。
 *
 * 提供:
 *   - checkoutRepo: GitHub リポジトリを clone して base_commit で checkout
 *   - gitStatus / gitDiff: エージェントが変更したファイルの diff を取得
 *   - applyPatch: git apply でパッチ（test_patch / agent patch）を適用
 *   - resetHard: 作業ツリーを base_commit まで巻き戻す
 *
 * セキュリティ: コマンドは execFile で固定引数で実行（shell は使わない）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** 実行結果。 */
export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * git コマンドを cwd で実行する。引数は配列（shell 不使用・安全）。
 */
export async function runGit(cwd: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return runCommand(cwd, 'git', args, timeoutMs);
}

/**
 * 任意のコマンドを cwd で実行する（テスト実行・環境セットアップ用）。
 * 引数は配列（shell 不使用・安全）。shell が必要な場合は runShell を使う。
 */
export async function runCommand(cwd: string, cmd: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number | null };
    return { ok: false, code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** シェル経由で 1 コマンドを実行する（setup-cmd 等）。 */
export async function runShell(cwd: string, command: string, timeoutMs = 300_000): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number | null };
    return { ok: false, code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** リポジトリ URL を組み立てる（git clone 用）。 */
export function repoCloneUrl(repo: string): string {
  // 'owner/repo' → https://github.com/owner/repo.git
  return `https://github.com/${repo.replace(/\/+$/, '')}.git`;
}

/**
 * GitHub リポジトリを clone し、baseCommit で checkout する。
 * 既にディレクトリが存在して git リポジトリなら clone をスキップする（再開可能）。
 */
export async function checkoutRepo(opts: {
  repo: string;
  baseCommit: string;
  /** 作業ディレクトリ（clone 先の親 or ルート）。 */
  workDir: string;
}): Promise<{ ok: boolean; repoDir: string; error?: string }> {
  const { repo, baseCommit, workDir } = opts;
  const repoDir = path.join(workDir, 'repo');

  // 既に有効なリポジトリなら再初期化しない
  const existing = await runGit(workDir, ['rev-parse', '--is-inside-work-tree']);
  if (existing.ok) {
    const reset = await runGit(workDir, ['reset', '--hard', baseCommit]);
    if (reset.ok) {
      const clean = await runGit(workDir, ['clean', '-fd']);
      void clean;
      return { ok: true, repoDir: workDir };
    }
    // base_commit が無い場合は clone し直す
  }

  // clone
  await fs.rm(repoDir, { recursive: true, force: true });
  const clone = await runGit(workDir, ['clone', '--quiet', repoCloneUrl(repo), 'repo'], 300_000);
  if (!clone.ok) {
    return { ok: false, repoDir, error: `git clone 失敗: ${clone.stderr.slice(0, 300)}` };
  }
  const co = await runGit(repoDir, ['checkout', '--quiet', baseCommit], 120_000);
  if (!co.ok) {
    // フェッチしてから再試行
    await runGit(repoDir, ['fetch', '--quiet', 'origin', baseCommit], 120_000);
    const co2 = await runGit(repoDir, ['checkout', '--quiet', baseCommit], 120_000);
    if (!co2.ok) {
      return { ok: false, repoDir, error: `base_commit checkout 失敗: ${co2.stderr.slice(0, 300)}` };
    }
  }
  return { ok: true, repoDir };
}

/** リポジトリ内の変更ファイル一覧を取得（git status --porcelain）。 */
export async function changedFiles(repoDir: string): Promise<string[]> {
  const r = await runGit(repoDir, ['status', '--porcelain']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter((l) => l.trim() !== '')
    .map((l) => l.slice(3).trim()) // 先頭の状態文字2字 + 空白を除去
    .filter((p) => p !== '');
}

/**
 * 作業ツリーの変更全体を diff（text）として取得。
 *
 * エージェントが新規ファイルを作成した場合も model_patch に含めるため、
 * untracked ファイルへ intent-to-add（git add -N）を適用してから差分を取る。
 * intent-to-add が失敗した場合はエラーとして扱う（既存の modelPatch 生成を
 * 壊さないよう、失敗時は diff を空にして呼び出し元へ伝える）。
 */
export async function gitDiff(repoDir: string): Promise<{ ok: boolean; diff: string; error?: string }> {
  // 1) untracked ファイルを差分対象へ（新規ファイルの追加を model_patch に含める）
  const ita = await runGit(repoDir, ['add', '-N', '.']);
  if (!ita.ok) {
    return { ok: false, diff: '', error: `git add -N 失敗: ${ita.stderr.slice(0, 300)}` };
  }
  // 2) 差分を取得
  const r = await runGit(repoDir, ['diff', 'HEAD']);
  if (!r.ok) return { ok: false, diff: '', error: r.stderr.slice(0, 300) };
  return { ok: true, diff: r.stdout };
}

/** パッチ（unified diff）を git apply で適用する。 */
export async function applyPatch(repoDir: string, patch: string): Promise<{ ok: boolean; error?: string }> {
  if (!patch.trim()) return { ok: true };
  // 一時ファイルに書き出して適用。偽の index/blob hash を含むパッチは 3way が
  // 失敗するため、順に 素の apply → --3way → --reject を試す。
  const tmp = path.join(repoDir, '.swe-apply.patch');
  await fs.writeFile(tmp, patch, 'utf8');

  // 1) 素の apply（コンテキスト一致で適用）
  const plain = await runGit(repoDir, ['apply', '--whitespace=nowarn', tmp]);
  if (plain.ok) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return { ok: true };
  }
  // 2) 3way（index 行の blob が実在する場合に有効）
  const threeway = await runGit(repoDir, ['apply', '--3way', tmp]);
  if (threeway.ok) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return { ok: true };
  }
  // 3) reject（部分適用を試み、失敗 hunk は .rej に残す）
  const reject = await runGit(repoDir, ['apply', '--reject', '--whitespace=nowarn', tmp]);
  await fs.rm(tmp, { force: true }).catch(() => undefined);
  if (reject.ok) return { ok: true };
  return { ok: false, error: `git apply 失敗: ${reject.stderr.slice(0, 400)}` };
}

/** 作業ツリーを HEAD まで巻き戻す（agent の変更を破棄する前処理用）。 */
export async function resetHard(repoDir: string): Promise<boolean> {
  const r = await runGit(repoDir, ['reset', '--hard', 'HEAD']);
  const c = await runGit(repoDir, ['clean', '-fd']);
  return r.ok && c.ok;
}
