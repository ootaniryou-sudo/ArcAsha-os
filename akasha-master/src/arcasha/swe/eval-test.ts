/**
 * SWE-bench 評価ハーネスの E2E 決定論検証（API 呼び出しなし）。
 *
 *   npm run swe:eval-test
 *
 * ローカルに git リポジトリ（base_commit = バグ有り）を構築し、test_patch /
 * 解決パッチの適用と FAIL_TO_PASS / PASS_TO_PASS の pytest 判定が正しく動くか
 * 検証する。エージェント（LLM）は使わず、modelPatchOverride で解決パッチを直接
 * 渡す。
 *
 * 検証シナリオ:
 *   1. 正しい解決パッチを渡す → resolved=true（FAIL_TO_PASS が通る）
 *   2. 空パッチ（未解決）を渡す → resolved=false
 *   3. instance ローダが .jsonl / .json を正しく読める
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SweBenchInstance } from './instance.js';
import { loadSweBenchInstances } from './instance.js';
import { evaluateInstance, renderSweEval } from './eval.js';
import { applyPatch } from './repo.js';

const execFileAsync = promisify(execFile);

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function git(dir: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: dir });
}

/** バグ有り factorial リポジトリをローカルに構築し、コミットを返す。 */
async function buildBuggyRepo(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'math_lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'math_lib', '__init__.py'), 'from .calc import factorial\n\n__all__ = ["factorial"]\n', 'utf8');
  // バグ: range(1, n) → (n-1)! を返す
  await fs.writeFile(path.join(root, 'math_lib', 'calc.py'), [
    'def factorial(n: int) -> int:',
    '    """Return n! for non-negative n."""',
    '    if n <= 1:',
    '        return 1',
    '    result = 1',
    '    for i in range(1, n):',
    '        result *= i',
    '    return result',
    '',
  ].join('\n'), 'utf8');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'buggy factorial');
}

/** test_patch: factorial の正しさを検証するテストを追加する unified diff。 */
function buildTestPatch(): string {
  return [
    'diff --git a/tests/test_factorial.py b/tests/test_factorial.py',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/tests/test_factorial.py',
    '@@ -0,0 +1,10 @@',
    '+import sys',
    '+sys.path.insert(0, ".")',
    '+from math_lib.calc import factorial',
    '+',
    '+def test_factorial_5():',
    '+    assert factorial(5) == 120',
    '+',
    '+def test_factorial_6():',
    '+    assert factorial(6) == 720',
    '+',
    '',
  ].join('\n');
}

/**
 * リポジトリ上のファイルを修正し、実際の git diff を gold patch として返す。
 * （ハードコードした hunk は git apply の行数検証に失敗し得るため、実 diff を使う）
 */
async function buildGoldPatchFromRepo(repoDir: string): Promise<string> {
  // calc.py を修正（range(1, n) → range(1, n + 1)）
  const calcPath = path.join(repoDir, 'math_lib', 'calc.py');
  const orig = await fs.readFile(calcPath, 'utf8');
  const fixed = orig.replace('for i in range(1, n):', 'for i in range(1, n + 1):');
  if (fixed === orig) throw new Error('gold patch 生成: calc.py を修正できませんでした');
  await fs.writeFile(calcPath, fixed, 'utf8');
  const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], { cwd: repoDir });
  // 巻き戻してクリーンに戻す
  await execFileAsync('git', ['checkout', '--', 'math_lib/calc.py'], { cwd: repoDir });
  return stdout;
}

/**
 * pytest を実行できる python バイナリを解決する。
 * 優先順: env SWE_PYTHON → システム python3（pytest が import できるか確認）→ 'python3'
 * （ローカル実行では、pytest が入った環境を SWE_PYTHON で明示するのが確実）
 */
async function resolvePythonBin(): Promise<string> {
  if (process.env.SWE_PYTHON) return process.env.SWE_PYTHON;
  for (const cand of ['python3', 'python']) {
    try {
      await execFileAsync(cand, ['-c', 'import pytest'], { timeout: 10_000 });
      return cand;
    } catch {
      // 次の候補を試す
    }
  }
  return 'python3';
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-swe-eval-'));
  console.log(`temp dir: ${tmp}\n`);
  const pythonBin = await resolvePythonBin();
  console.log(`python: ${pythonBin}（env SWE_PYTHON で上書き可）\n`);

  // 各シナリオで独立したリポジトリを使う（評価が互いに汚染しないように）
  async function freshRepo(): Promise<{ dir: string; commit: string }> {
    const dir = path.join(tmp, `repo-${Math.random().toString(36).slice(2, 8)}`);
    await buildBuggyRepo(dir);
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    return { dir, commit };
  }

  function makeInstance(commit: string): SweBenchInstance {
    return {
      instance_id: 'local__factorial-1',
      repo: 'local/factorial',
      base_commit: commit,
      problem_statement: 'factorial(n) は n! を返すべきですが、現在 (n-1)! を返します。修正してください。',
      test_patch: buildTestPatch(),
      FAIL_TO_PASS: ['tests/test_factorial.py::test_factorial_5', 'tests/test_factorial.py::test_factorial_6'],
      PASS_TO_PASS: [],
    };
  }

  try {
    // ---- 1. 正しい解決パッチ → resolved=true ----
    console.log('--- 1. 正しい解決パッチで評価 ---');
    const f1 = await freshRepo();
    const inst1 = makeInstance(f1.commit);
    const goldPatch = await buildGoldPatchFromRepo(f1.dir);
    check('gold patch が生成される', goldPatch.includes('range(1, n + 1)'), goldPatch.slice(0, 200));
    const r1 = await evaluateInstance(inst1, { repoDir: f1.dir, verbose: true, allowRunCommand: true, pythonBin }, goldPatch);
    console.log(renderSweEval(r1));
    console.log('');
    check('正しい解決パッチで resolved=true', r1.resolved, JSON.stringify(r1.failToPass));
    check('FAIL_TO_PASS が全件 pass', r1.failToPass.length === 2 && r1.failToPass.every((t) => t.passed), JSON.stringify(r1.failToPass));

    // ---- 2. 空パッチ（未解決）→ resolved=false ----
    console.log('--- 2. 空パッチ（未解決）で評価 ---');
    const f2 = await freshRepo();
    const inst2 = makeInstance(f2.commit);
    const r2 = await evaluateInstance(inst2, { repoDir: f2.dir, verbose: false, allowRunCommand: true, pythonBin }, '');
    console.log(renderSweEval(r2));
    console.log('');
    check('未解決（空パッチ）で resolved=false', !r2.resolved, JSON.stringify(r2.failToPass));

    // ---- 3. instance ローダ（.json） ----
    console.log('--- 3. instance ローダ（.json） ---');
    const instJsonPath = path.join(tmp, 'instances.json');
    await fs.writeFile(instJsonPath, JSON.stringify([inst1]), 'utf8');
    const loaded = await loadSweBenchInstances(instJsonPath);
    check('instance ローダが .json を読める', loaded.instances.length === 1 && loaded.instances[0].instance_id === inst1.instance_id);

    // ---- 4. applyPatch が unified diff を適用できる ----
    console.log('--- 4. applyPatch 単体 ---');
    const f4 = await freshRepo();
    const ap = await applyPatch(f4.dir, inst1.test_patch!);
    const testFile = await fs.readFile(path.join(f4.dir, 'tests', 'test_factorial.py'), 'utf8').catch(() => '');
    check('applyPatch が test_patch を適用', ap.ok && testFile.includes('test_factorial_5'), ap.error ?? '');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? '✅ ALL PASS — SWE eval harness' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
