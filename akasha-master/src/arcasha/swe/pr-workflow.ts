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

function gitExec(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitOut> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    // P2: ネットワーク push や Git hook が無限にブロックしないようタイムアウトを設ける。
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, out, err: `タイムアウト（${Math.floor(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, out, err: e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** ブランチ名を生成する（例: arcasha/agent/<timestamp>-<ms>-<rand>）。 */
export function branchName(prefix = 'arcasha/agent'): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  // P2: 1 秒以内の並行実行でもブランチ名が衝突しないよう ms + 乱数を付与する
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}/${ts}-${ms}-${rand}`;
}

/** 作業ツリーがクリーン（未コミット変更なし）か確認する。 */
export async function isCleanWorktree(cwd: string): Promise<boolean> {
  const r = await gitExec(cwd, ['status', '--porcelain']);
  return r.code === 0 && r.out.trim() === '';
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
  // リモートが無い場合・origin が無い場合はローカル commit のみで OK
  const remotes = await gitExec(cwd, ['remote']);
  const remoteNames = remotes.code === 0 ? remotes.out.trim().split(/\s+/).filter(Boolean) : [];
  if (remoteNames.length === 0) {
    return { ok: true, message: `ローカルブランチ ${branch} に commit（リモートなし）`, diff: diff.out };
  }
  // P2: origin が無い場合は最初のリモートを使う（origin 固定だと push が失敗する）
  const remote = remoteNames.includes('origin') ? 'origin' : remoteNames[0];
  const push = await gitExec(cwd, ['push', '-u', remote, branch]);
  if (push.code !== 0) {
    return { ok: false, message: `push 失敗: ${push.err}`, diff: diff.out };
  }
  return { ok: true, message: `ブランチ ${branch} を ${remote} へ push`, diff: diff.out };
}
