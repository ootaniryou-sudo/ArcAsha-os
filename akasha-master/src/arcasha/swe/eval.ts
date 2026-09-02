/**
 * SWE-bench 評価ハーネス。
 *
 * フロー:
 *   1. repo を base_commit で checkout
 *   2. runSweAgent に problem_statement（issue）を渡して解決させる
 *   3. エージェントの変更を git diff として取得（model_patch）
 *   4. リポジトリを base_commit まで巻き戻す
 *   5. test_patch を適用（FAIL_TO_PASS を有効化）
 *   6. model_patch を適用
 *   7. pytest で FAIL_TO_PASS / PASS_TO_PASS を実行し、解決したか判定
 *
 * 注: 現実の SWE-bench は環境セットアップ（pip install 等）が instance ごとに
 * 異なるため、本ハーネスは「pytest が依存なしで動く小〜中規模リポジトリ」を
 * 想定した軽量版。依存インストールが必要な instance は opts.setupCmd で指定する。
 */
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import type { SweBenchInstance } from './instance.js';
import type { SweAgentOptions } from './agent.js';
import { runSweAgent } from './agent.js';
import { isTestFilePath } from './tools.js';
import { checkoutRepo, gitDiff, applyPatch, resetHard, runCommand, runShell } from './repo.js';

/** 評価オプション。 */
export interface SweEvalOptions {
  /** 作業ルート（clone 先・一時ディレクトリ）。既定: システム temp。 */
  workRoot?: string;
  /**
   * 既にチェックアウト済みのリポジトリディレクトリ（絶対パス）。
   * 指定すると checkout をスキップしてこのディレクトリを評価する（ローカル検証用）。
   */
  repoDir?: string;
  /** runSweAgent への追加オプション（allowRunCommand 等）。 */
  agent?: Partial<SweAgentOptions>;
  /** エージェント実行の最大イテレーション（既定 30）。 */
  maxIterations?: number;
  /** run_command（pytest 等）を許可するか。既定 false。 */
  allowRunCommand?: boolean;
  /** リポジトリ環境セットアップコマンド（例: 'pip install -e .'）。任意。 */
  setupCmd?: string;
  /** pytest 実行のタイムアウト（ms・既定 5 分）。 */
  pytestTimeoutMs?: number;
  /**
   * PASS_TO_PASS（回帰確認）の実行上限。既定 5。
   * SWE-bench の resolved 判定は FAIL_TO_PASS のみで行う（公式ハーネス準拠）ため、
   * P2P は回帰確認として代表テストを上限件数だけ実行する（数千件ある instance が
   * あるため全件実行は非現実的）。上限を変えたい場合はこの値を指定する。
   */
  passToPassLimit?: number;
  /**
   * python / pytest 実行に使うバイナリ（既定: env SWE_PYTHON か 'python3'）。
   * 例: '/usr/local/bin/python3'（pytest が入っている環境を明示する場合）。
   */
  pythonBin?: string;
  /** エージェント実行とテストの詳細ログを出すか。 */
  verbose?: boolean;
}

/** 単一テストの実行結果。 */
export interface TestResult {
  test: string;
  passed: boolean;
  /** 失敗時のみエラー概要。 */
  error?: string;
}

/** instance ごとの評価結果。 */
export interface SweEvalResult {
  instance_id: string;
  /** 解決したか（FAIL_TO_PASS が全て通った）。 */
  resolved: boolean;
  /** エージェントが生成したパッチ（git diff）。 */
  modelPatch: string;
  /** FAIL_TO_PASS テストの実行結果。 */
  failToPass: TestResult[];
  /** PASS_TO_PASS テストの実行結果。 */
  passToPass: TestResult[];
  /** エージェントのツール呼び出し数。 */
  agentToolCalls: number;
  /** エージェントのモデル呼び出し数。 */
  agentModelCalls: number;
  /** エージェントのプロンプト（入力）トークン合計。 */
  agentPromptTokens?: number;
  /** エージェントの生成（出力）トークン合計。 */
  agentCompletionTokens?: number;
  /** エージェントの合計トークン。 */
  agentTotalTokens?: number;
  /** 全体の経過時間（ms）。 */
  totalMs: number;
  /** エラー（途中失敗時）。 */
  error?: string;
}

/**
 * pytest で指定テストを実行し、全テストが通ったか判定する。
 * exit code 0 = 全 pass / 1 = 失敗あり / 2 = collection エラー / 5 = 見つからない
 */
async function runTests(repoDir: string, tests: string[], timeoutMs: number, pythonBin: string): Promise<{ code: number | null; output: string }> {
  const args = ['-m', 'pytest', '-q', '--no-header', '-p', 'no:cacheprovider', ...tests];
  const r = await runCommand(repoDir, pythonBin, args, timeoutMs);
  return { code: r.code, output: `${r.stdout}\n${r.stderr}`.trim() };
}

/**
 * SWE-bench のテスト名を pytest の node id に解決する。
 *
 * sympy / django 等の一部リポジトリでは FAIL_TO_PASS / PASS_TO_PASS が
 * 「関数名のみ」（例: test_prefix_operations）で、テストファイルが含まれない。
 * その場合、リポジトリ内で「def <名前>」を定義しているテストファイルを検索し、
 * `<ファイルパス>::<関数名>` の形に解決する。
 *
 * 関数名が複数ファイルに存在し得るため、`preferredFiles`（通常は test_patch が
 * 変更するテストファイル群）を最優先し、見つからなければリポジトリ全体から
 * 最初にヒットしたファイルを使う。既に `path::func` 形式ならそのまま返す。
 * 解決できない場合は元の名前を返す（pytest がエラーを返すため失敗扱いになる）。
 */
async function resolveTestNodeIds(repoDir: string, testNames: string[], preferredFiles: string[] = []): Promise<string[]> {
  const resolved: string[] = [];
  for (const name of testNames) {
    if (name.includes('::')) {
      resolved.push(name);
      continue;
    }
    // 1) 優先ファイル群（test_patch の対象テストファイル）から探す
    let found = '';
    for (const f of preferredFiles) {
      const check = await runCommand(repoDir, 'grep', ['-q', `def ${name}`, path.join(repoDir, f)]);
      if (check.ok) {
        found = `${f.replace(/^\.\//, '')}::${name}`;
        break;
      }
    }
    // 2) 見つからなければリポジトリ全体から「def <name>」を定義する .py を検索
    if (found === '') {
      const r = await runCommand(repoDir, 'grep', ['-rl', `def ${name}`, '--include=*.py', '.'], 60_000);
      if (r.ok && r.stdout.trim()) {
        found = `${r.stdout.trim().split('\n')[0].replace(/^\.\//, '').trim()}::${name}`;
      }
    }
    resolved.push(found !== '' ? found : name);
  }
  return resolved;
}

/** python 実行バイナリを解決する（opts → env SWE_PYTHON → 'python3'）。 */
function resolvePythonBin(pythonBin?: string): string {
  return pythonBin ?? process.env.SWE_PYTHON ?? 'python3';
}

/** unified diff（test_patch 等）から変更対象のファイルパス（b/ 側）を抽出する。 */
function extractPatchFiles(patch: string): string[] {
  if (!patch) return [];
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    const m = /^\+\+\+ b\/(.+?)\s*$/.exec(line.trim());
    if (m) files.push(m[1].trim());
  }
  return files;
}

/**
 * unified diff（エージェントの modelPatch）からテストファイルの変更を除去する。
 *
 * SWE-bench ではテストは評価時に gold の test_patch として適用されるため、
 * エージェントによるテスト改変（run_command 経由を含む）を model_patch に含めない。
 * これにより test_patch 適用後の model_patch 適用でコンフリクトするのを防ぐ。
 */
function stripTestFileChanges(diff: string): string {
  if (!diff.trim()) return diff;
  const sections = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  for (const sec of sections) {
    if (!sec.trim()) continue;
    const m = /^\+\+\+ b\/(.+?)(?:\s|$)/m.exec(sec);
    if (m && isTestFilePath(m[1].replace(/^"|"$/g, ''))) {
      continue; // テストファイル変更は除去
    }
    kept.push(sec);
  }
  return kept.join('');
}

/** 環境セットアップコマンドを実行（任意）。shell 経由（依存 install 等）。 */
async function runSetup(repoDir: string, cmd: string): Promise<boolean> {
  if (!cmd.trim()) return true;
  const r = await runShell(repoDir, cmd, 300_000);
  return r.ok;
}

/**
 * 1 つの instance を評価する。
 * - solve=true（既定）: エージェントで解いてから評価
 * - solve=false: 既存のエージェント実行結果（modelPatch を渡す）だけを評価
 */
export async function evaluateInstance(
  inst: SweBenchInstance,
  opts: SweEvalOptions = {},
  modelPatchOverride?: string,
): Promise<SweEvalResult> {
  const t0 = Date.now();
  const workRoot = opts.workRoot ?? path.join(os.tmpdir(), 'arcasha-swebench');
  await fs.mkdir(workRoot, { recursive: true });

  let agentToolCalls = 0;
  let agentModelCalls = 0;
  let agentPromptTokens = 0;
  let agentCompletionTokens = 0;
  let modelPatch = modelPatchOverride ?? '';
  const pythonBin = resolvePythonBin(opts.pythonBin);

  try {
    // 1. checkout（repoDir 指定時はスキップしてローカルリポジトリを使う）
    let repoDir = opts.repoDir ?? '';
    if (repoDir === '') {
      if (opts.verbose) console.log(`[eval] checkout ${inst.repo} @ ${inst.base_commit.slice(0, 8)}`);
      const co = await checkoutRepo({ repo: inst.repo, baseCommit: inst.base_commit, workDir: workRoot });
      if (!co.ok) {
        return { instance_id: inst.instance_id, resolved: false, modelPatch: '', failToPass: [], passToPass: [], agentToolCalls, agentModelCalls, agentPromptTokens, agentCompletionTokens, agentTotalTokens: agentPromptTokens + agentCompletionTokens, totalMs: Date.now() - t0, error: co.error };
      }
      repoDir = co.repoDir;
    }

    // 2. エージェントで解く（modelPatchOverride 未指定のときのみ実行）
    const shouldSolve = modelPatchOverride === undefined;
    if (shouldSolve) {
      if (opts.verbose) console.log(`[eval] agent solving ${inst.instance_id}`);
      const agentResult = await runSweAgent({
        root: repoDir,
        issue: inst.problem_statement,
        maxIterations: opts.maxIterations ?? 30,
        allowRunCommand: opts.allowRunCommand === true,
        ...(opts.agent ?? {}),
      });
      agentModelCalls = agentResult.modelCalls;
      agentToolCalls = agentResult.toolCalls;
      agentPromptTokens = agentResult.promptTokens ?? 0;
      agentCompletionTokens = agentResult.completionTokens ?? 0;
      // ツール実行で変更されたファイルの diff を取得
      const diff = await gitDiff(repoDir);
      if (!diff.ok) {
        return { instance_id: inst.instance_id, resolved: false, modelPatch: '', failToPass: [], passToPass: [], agentToolCalls: agentResult.toolCalls, agentModelCalls, agentPromptTokens, agentCompletionTokens, agentTotalTokens: agentPromptTokens + agentCompletionTokens, totalMs: Date.now() - t0, error: `git diff 失敗: ${diff.error}` };
      }
      // テストファイルの変更は model_patch から除去（評価は gold test_patch で行うため）
      modelPatch = stripTestFileChanges(diff.diff);
      if (opts.verbose) {
        console.log(`[eval] agent done: ${agentResult.modelCalls} calls / ${agentResult.toolCalls} tools / diff ${modelPatch.length} bytes / ok=${agentResult.ok}`);
        console.log(`[eval] final answer head: ${agentResult.finalAnswer.slice(0, 200)}`);
      }
    }

    // 3. 巻き戻し（エージェントで解いたときのみ・modelPatchOverride は適用前提のため巻き戻さない）
    if (shouldSolve) {
      await resetHard(repoDir);
    }

    // 4. 環境セットアップ（任意）
    if (opts.setupCmd) {
      if (opts.verbose) console.log(`[eval] setup: ${opts.setupCmd}`);
      const setupOk = await runSetup(repoDir, opts.setupCmd);
      if (!setupOk) {
        return { instance_id: inst.instance_id, resolved: false, modelPatch, failToPass: [], passToPass: [], agentToolCalls, agentModelCalls, agentPromptTokens, agentCompletionTokens, agentTotalTokens: agentPromptTokens + agentCompletionTokens, totalMs: Date.now() - t0, error: `環境セットアップ失敗: ${opts.setupCmd}` };
      }
    }

    // 5. test_patch を適用
    if (inst.test_patch) {
      if (opts.verbose) console.log('[eval] applying test_patch');
      const tp = await applyPatch(repoDir, inst.test_patch);
      if (!tp.ok) {
        return { instance_id: inst.instance_id, resolved: false, modelPatch, failToPass: [], passToPass: [], agentToolCalls, agentModelCalls, agentPromptTokens, agentCompletionTokens, agentTotalTokens: agentPromptTokens + agentCompletionTokens, totalMs: Date.now() - t0, error: `test_patch 適用失敗: ${tp.error}` };
      }
    }

    // 6. model_patch を適用（解決差分）
    if (modelPatch.trim() !== '') {
      if (opts.verbose) console.log(`[eval] applying model_patch (${modelPatch.length} bytes)`);
      const mp = await applyPatch(repoDir, modelPatch);
      if (!mp.ok) {
        return { instance_id: inst.instance_id, resolved: false, modelPatch, failToPass: [], passToPass: [], agentToolCalls, agentModelCalls, agentPromptTokens, agentCompletionTokens, agentTotalTokens: agentPromptTokens + agentCompletionTokens, totalMs: Date.now() - t0, error: `model_patch 適用失敗: ${mp.error}` };
      }
    }

    // 7. FAIL_TO_PASS 実行（関数名のみのテストはファイルを解決して node id 化）
    const preferredTestFiles = extractPatchFiles(inst.test_patch ?? '');
    const failToPassNodeIds = await resolveTestNodeIds(repoDir, inst.FAIL_TO_PASS, preferredTestFiles);
    const failToPass: TestResult[] = [];
    for (let i = 0; i < inst.FAIL_TO_PASS.length; i++) {
      const test = inst.FAIL_TO_PASS[i];
      const nodeId = failToPassNodeIds[i] ?? test;
      if (opts.verbose) console.log(`[eval] FAIL_TO_PASS: ${nodeId}`);
      const r = await runTests(repoDir, [nodeId], opts.pytestTimeoutMs ?? 300_000, pythonBin);
      // 対象テストだけに絞って通ったかを再実行で確認（exit code 0 = pass）
      failToPass.push({ test, passed: r.code === 0, error: r.code !== 0 ? `exit ${r.code}` : undefined });
      if (opts.verbose && r.code !== 0) console.log(`    -> FAIL (exit ${r.code})`);
    }

    // 8. PASS_TO_PASS 実行（回帰確認・上限は opts.passToPassLimit、既定 5）
    //    注: resolved は SWE-bench 公式ハーネスと同様に FAIL_TO_PASS のみで判定する。
    //    P2P は回帰確認（モデル修正が既存テストを壊していないことの確認）であり、
    //    数千件ある instance での全件実行を避けるため上限件数を実行する。
    const p2pLimit = Number.isSafeInteger(opts.passToPassLimit) && (opts.passToPassLimit as number) >= 1
      ? (opts.passToPassLimit as number)
      : 5;
    const passToPassLimit = inst.PASS_TO_PASS.length > p2pLimit ? inst.PASS_TO_PASS.slice(0, p2pLimit) : inst.PASS_TO_PASS;
    const passToPassNodeIds = await resolveTestNodeIds(repoDir, passToPassLimit, preferredTestFiles);
    const passToPass: TestResult[] = [];
    for (let i = 0; i < passToPassLimit.length; i++) {
      const test = passToPassLimit[i];
      const nodeId = passToPassNodeIds[i] ?? test;
      if (opts.verbose) console.log(`[eval] PASS_TO_PASS: ${nodeId}`);
      const r = await runTests(repoDir, [nodeId], opts.pytestTimeoutMs ?? 300_000, pythonBin);
      passToPass.push({ test, passed: r.code === 0, error: r.code !== 0 ? `exit ${r.code}` : undefined });
    }

    // resolved = FAIL_TO_PASS が全て通った（SWE-bench 公式の判定基準。P2P は回帰確認）
    const resolved = failToPass.length > 0 && failToPass.every((t) => t.passed);
    return {
      instance_id: inst.instance_id,
      resolved,
      modelPatch,
      failToPass,
      passToPass,
      agentToolCalls,
      agentModelCalls,
      agentPromptTokens,
      agentCompletionTokens,
      agentTotalTokens: agentPromptTokens + agentCompletionTokens,
      totalMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      instance_id: inst.instance_id,
      resolved: false,
      modelPatch,
      failToPass: [],
      passToPass: [],
      agentToolCalls,
      agentModelCalls,
      agentPromptTokens,
      agentCompletionTokens,
      agentTotalTokens: agentPromptTokens + agentCompletionTokens,
      totalMs: Date.now() - t0,
      error: (e as Error).message,
    };
  }
}

/** 評価結果の表示。 */
export function renderSweEval(r: SweEvalResult): string {
  const lines: string[] = [];
  lines.push(`📦 ${r.instance_id} — ${r.resolved ? '✅ RESOLVED' : '❌ NOT RESOLVED'} (${r.totalMs}ms)`);
  lines.push(`   agent: ${r.agentModelCalls} calls / ${r.agentToolCalls} tools`);
  if (r.agentTotalTokens) lines.push(`   tokens: ${r.agentPromptTokens} in / ${r.agentCompletionTokens} out (total ${r.agentTotalTokens})`);
  if (r.error) lines.push(`   error: ${r.error}`);
  lines.push(`   FAIL_TO_PASS:`);
  for (const t of r.failToPass) lines.push(`     ${t.passed ? '✅' : '❌'} ${t.test}${t.error ? ` (${t.error})` : ''}`);
  lines.push(`   PASS_TO_PASS:`);
  for (const t of r.passToPass) lines.push(`     ${t.passed ? '✅' : '❌'} ${t.test}${t.error ? ` (${t.error})` : ''}`);
  lines.push(`   modelPatch: ${r.modelPatch.length} bytes`);
  return lines.join('\n');
}
