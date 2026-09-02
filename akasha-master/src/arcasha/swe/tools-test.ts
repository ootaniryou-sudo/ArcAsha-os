/**
 * SWE-bench ツール群の決定論検証（動作確認用・API 呼び出しなし）。
 *
 *   npm run swe:tools-test
 *
 * 一時ディレクトリにサンプルリポジトリを作り、list_dir / read_file / grep_search /
 * glob_search / write_file / edit_file / run_command が期待通り動くか確認する。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSweTool } from './tools.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-swe-test-'));
  const ctx = { root };
  console.log(`temp repo: ${root}\n`);

  try {
    // サンプルファイル作成
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'math.py'), 'def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n', 'utf8');
    await fs.writeFile(path.join(root, 'tests', 'test_math.py'), 'from math import add\n\ndef test_add():\n    assert add(1, 2) == 3\n', 'utf8');
    await fs.writeFile(path.join(root, 'README.md'), '# Sample\n\nadd and mul functions.\n', 'utf8');
    await fs.writeFile(path.join(root, '.hidden.py'), 'print("skip")\n', 'utf8');

    // list_dir
    const l = await getSweTool('list_dir')!.run({ path: '.' }, ctx);
    check('list_dir が root を表示', l.ok && l.output.includes('src') && l.output.includes('README.md'), l.output);

    // read_file（全行）
    const rAll = await getSweTool('read_file')!.run({ path: 'src/math.py' }, ctx);
    check('read_file 全行', rAll.ok && rAll.output.includes('def add') && rAll.output.includes('1│'), rAll.output);

    // read_file（行範囲）
    const rRange = await getSweTool('read_file')!.run({ path: 'src/math.py', start_line: 1, end_line: 2 }, ctx);
    check('read_file 行範囲', rRange.ok && rRange.output.includes('def add') && !rRange.output.includes('def mul'), rRange.output);

    // grep_search
    const g = await getSweTool('grep_search')!.run({ pattern: 'def mul' }, ctx);
    check('grep_search が def mul を発見', g.ok && g.output.includes('src/math.py:4'), g.output);

    // glob_search
    const gl = await getSweTool('glob_search')!.run({ pattern: '**/*.py' }, ctx);
    check('glob_search が *.py を列挙', gl.ok && gl.output.includes('src/math.py') && gl.output.includes('tests/test_math.py'), gl.output);

    // write_file（新規）
    const w = await getSweTool('write_file')!.run({ path: 'src/new.py', content: 'x = 1\n' }, ctx);
    const newExists = await fs.readFile(path.join(root, 'src', 'new.py'), 'utf8').catch(() => '');
    check('write_file 新規作成', w.ok && newExists === 'x = 1\n', w.output);

    // edit_file（置換）
    const e = await getSweTool('edit_file')!.run({ path: 'src/math.py', old_string: 'return a * b', new_string: 'return a * b + 1' }, ctx);
    const edited = await fs.readFile(path.join(root, 'src', 'math.py'), 'utf8');
    check('edit_file 置換', e.ok && edited.includes('return a * b + 1') && !edited.includes('return a * b\n'), e.output);

    // run_command
    const cmd = await getSweTool('run_command')!.run({ command: 'python3 -c "print(6*7)"' }, ctx);
    check('run_command 実行（exit 0）', cmd.ok && cmd.output.includes('42'), cmd.output);

    // 安全策: root 外パスは拒否
    const outside = await getSweTool('read_file')!.run({ path: '/etc/hostname' }, ctx);
    check('root 外パスは拒否', !outside.ok, outside.output);

    // 未知ツールは undefined
    check('未知ツールは undefined', getSweTool('nope') === undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? '✅ ALL PASS — SWE tools' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
