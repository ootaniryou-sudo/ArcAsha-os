/**
 * PR ワークフロー — 実ワークスペース編集を安全に行うためのブランチ + commit + PR
 *
 * SWE-bench 評価（一時サンドボックス）は直接編集でよいが、/api/agent などが
 * 実ワークスペースを編集する場合、誤った変更が main に入るリスクがある。
 * safe-mode（ARCASHA_AGENT_SAFE_MODE=1）では、エージェントの編集を
 *  1. 作業ブランチ作成
 *  2. 変更を commit
 *  3. （可能なら）PR 作成
 * の流れに載せる。git コマンドは引数分離 spawn で実行する（シェルインジェクション防止）。
 */
import { spawn } from 'node:child_process';

/** git コマンド実行結果。 */
interface GitOut {
  code: number | null;
  out: string;
  err: string;
}

function gitExec(cwd: string, args: string[]): Promise<GitOut> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: null, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** ブランチ名を生成する（例: arcasha/agent/<timestamp>）。 */
export function branchName(prefix = 'arcasha/agent'): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  return `${prefix}/${ts}`;
}

/** リポジトリが git 管理か確認する。 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await gitExec(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.out.trim() === 'true';
}

/** 現在のブランチ名を取得する。 */
export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await gitExec(cwd, ['branch', '--show-current']);
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null;
}

/** 作業ブランチを作成して切り替える（既にブランチ上ならそのまま）。 */
export async function ensureBranch(cwd: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const cur = await currentBranch(cwd);
  if (cur === branch) return { ok: true, message: `既にブランチ ${branch} 上です` };
  const r = await gitExec(cwd, ['checkout', '-b', branch]);
  if (r.code !== 0) {
    // 既に同名ブランチが存在する場合は切り替える
    const co = await gitExec(cwd, ['checkout', branch]);
    if (co.code !== 0) return { ok: false, message: `ブランチ作成失敗: ${r.err || co.err}` };
    return { ok: true, message: `既存ブランチ ${branch} へ切替` };
  }
  return { ok: true, message: `ブランチ ${branch} を作成・切替` };
}

/** 変更をステージして commit する。 */
export async function commitAll(cwd: string, message: string): Promise<{ ok: boolean; message: string }> {
  const add = await gitExec(cwd, ['add', '-A']);
  if (add.code !== 0) return { ok: false, message: `git add 失敗: ${add.err}` };
  const commit = await gitExec(cwd, ['commit', '-m', message]);
  if (commit.code !== 0) {
    // 変更がない場合も成功扱い（空コミット防止）
    if (commit.err.includes('nothing to commit') || commit.err.includes('no changes added')) {
      return { ok: true, message: '変更なし（commit 不要）' };
    }
    return { ok: false, message: `git commit 失敗: ${commit.err}` };
  }
  return { ok: true, message: `コミット完了: ${message}` };
}

/** 変更を origin へ push し、PR 作成用の diff を返す。 */
export async function pushAndDiff(cwd: string, branch: string): Promise<{ ok: boolean; message: string; diff?: string }> {
  // 差分を取得（PR 用）
  const diff = await gitExec(cwd, ['diff', '--no-color', 'HEAD']);
  // push（リモートが無い場合はローカル commit のみで OK）
  const remotes = await gitExec(cwd, ['remote']);
  if (remotes.code === 0 && remotes.out.trim() !== '') {
    const push = await gitExec(cwd, ['push', '-u', 'origin', branch]);
    if (push.code !== 0) {
      return { ok: false, message: `push 失敗: ${push.err}`, diff: diff.out };
    }
    return { ok: true, message: `ブランチ ${branch} を origin へ push`, diff: diff.out };
  }
  return { ok: true, message: `ローカルブランチ ${branch} に commit（リモートなし）`, diff: diff.out };
}
