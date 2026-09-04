/**
 * SWE-bench ツール群の決定論検証（動作確認用・API 呼び出しなし）。
 *
 *   npm run swe:tools-test
 *
 * 一時ディレクトリにサンプルリポジトリを作り、list_dir / read_file / grep_search /
 * glob_search / write_file / edit_file / run_command に加え、編集強化（replace_all /
 * insert_line / append_line）、git 連携（git_status / git_diff / git_revert）、
 * テスト実行（run_tests）、検索強化（grep_context / find_symbol）、ファイル操作
 * （move_file / delete_file / delete_dir）が期待通り動くか確認する。
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSweTool } from './tools.js';
import { buildAilsmGuide, buildAilsmQuickGuide } from './ailsm-guide.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** git コマンドの簡易実行（テスト内ヘルパー）。 */
function gitExec(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return { ok: false, out: err.stderr ?? err.stdout ?? String(e) };
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

    // run_command（opt-in なしでは拒否）
    const cmdDenied = await getSweTool('run_command')!.run({ command: 'echo hi' }, ctx);
    check('run_command は opt-in なしで拒否', !cmdDenied.ok && cmdDenied.output.includes('無効'), cmdDenied.output);

    // run_command（allowRunCommand=true で実行）
    const cmdAllowed = await getSweTool('run_command')!.run({ command: 'python3 -c "print(6*7)"' }, { root, allowRunCommand: true });
    check('run_command 実行（opt-in + exit 0）', cmdAllowed.ok && cmdAllowed.output.includes('42'), cmdAllowed.output);

    // run_command の引数分離実行（args 指定 → シェルを介さず安全実行）
    const cmdArgs = await getSweTool('run_command')!.run(
      { command: 'python3', args: ['-c', 'import subprocess; print("safe-42")'] },
      { root, allowRunCommand: true },
    );
    check('run_command 引数分離実行（args 指定）', cmdArgs.ok && cmdArgs.output.includes('safe-42'), cmdArgs.output);

    // 安全策: root 外パスは拒否
    const outside = await getSweTool('read_file')!.run({ path: '/etc/hostname' }, ctx);
    check('root 外パスは拒否', !outside.ok, outside.output);

    // 安全策: symlink 迂回は拒否（全ファイル系ツールで検証）
    const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-swe-secret-'));
    try {
      await fs.writeFile(path.join(secretDir, 'secret.txt'), 'TOPSECRET', 'utf8');
      await fs.symlink(secretDir, path.join(root, 'evil-dir-link'));
      await fs.symlink(path.join(secretDir, 'secret.txt'), path.join(root, 'evil-file-link.txt'));
      // read: ディレクトリ symlink 経由
      const viaLink = await getSweTool('read_file')!.run({ path: 'evil-dir-link/secret.txt' }, ctx);
      check('read_file: ディレクトリ symlink 経由は拒否', !viaLink.ok, viaLink.output);
      // read: ファイル symlink 直接
      const viaFileLink = await getSweTool('read_file')!.run({ path: 'evil-file-link.txt' }, ctx);
      check('read_file: ファイル symlink 直接は拒否', !viaFileLink.ok, viaFileLink.output);
      // list_dir: ディレクトリ symlink 経由
      const listViaLink = await getSweTool('list_dir')!.run({ path: 'evil-dir-link' }, ctx);
      check('list_dir: symlink 経由は拒否', !listViaLink.ok, listViaLink.output);
      // edit_file: symlink 経由は拒否
      const editViaLink = await getSweTool('edit_file')!.run({ path: 'evil-file-link.txt', old_string: 'x', new_string: 'y' }, ctx);
      check('edit_file: symlink 経由は拒否', !editViaLink.ok, editViaLink.output);
      // write_file: symlink ディレクトリ配下への新規書き込みは拒否
      const writeViaLink = await getSweTool('write_file')!.run({ path: 'evil-dir-link/new.txt', content: 'x' }, ctx);
      check('write_file: symlink 経由は拒否', !writeViaLink.ok, writeViaLink.output);
      // grep_search: symlink ディレクトリ配下を検索対象にしても外へ出ない
      const grepViaLink = await getSweTool('grep_search')!.run({ pattern: 'TOPSECRET', path: 'evil-dir-link' }, ctx);
      check('grep_search: symlink 対象は拒否', !grepViaLink.ok, grepViaLink.output);
      // glob_search: symlink 経由のファイルは列挙されない
      const globViaLink = await getSweTool('glob_search')!.run({ pattern: '**/evil-*' }, ctx);
      check('glob_search: symlink 経由は列挙されない', globViaLink.ok && !globViaLink.output.includes('evil-file-link'), globViaLink.output);
    } finally {
      await fs.rm(secretDir, { recursive: true, force: true }).catch(() => undefined);
    }

    // ── v1.4: 編集強化（replace_all / insert_line / append_line） ──
    const NEW_TOOLS = ['replace_all', 'insert_line', 'append_line', 'git_diff', 'git_status', 'git_revert', 'run_tests', 'grep_context', 'find_symbol', 'move_file', 'delete_file', 'delete_dir'];
    check(`新ツール ${NEW_TOOLS.length} 種が登録済み`, NEW_TOOLS.every((n) => getSweTool(n) !== undefined), '');

    // replace_all（全箇所）
    await fs.writeFile(path.join(root, 'src', 'fruits.txt'), 'apple orange apple\napple\n', 'utf8');
    const ra = await getSweTool('replace_all')!.run({ path: 'src/fruits.txt', old_string: 'apple', new_string: 'banana' }, ctx);
    const raContent = await fs.readFile(path.join(root, 'src', 'fruits.txt'), 'utf8');
    check('replace_all が全 3 箇所を置換', ra.ok && ra.output.includes('3 箇所') && raContent === 'banana orange banana\nbanana\n', ra.output);

    // replace_all（occurrence = N 番目のみ = replace_nth 相当）
    await fs.writeFile(path.join(root, 'src', 'fruits2.txt'), 'x y x y\n', 'utf8');
    const ran = await getSweTool('replace_all')!.run({ path: 'src/fruits2.txt', old_string: 'x', new_string: 'z', occurrence: 2 }, ctx);
    const ranContent = await fs.readFile(path.join(root, 'src', 'fruits2.txt'), 'utf8');
    check('replace_all occurrence=2 は 2 番目のみ置換', ran.ok && ran.output.includes('2 番目') && ranContent === 'x y z y\n', ran.output);
    const raNotFound = await getSweTool('replace_all')!.run({ path: 'src/fruits2.txt', old_string: 'zzz', new_string: 'q' }, ctx);
    check('replace_all 不一致はエラー', !raNotFound.ok, raNotFound.output);

    // insert_line（指定行の前に挿入）
    await fs.writeFile(path.join(root, 'src', 'seq.txt'), 'one\ntwo\nthree\n', 'utf8');
    const il = await getSweTool('insert_line')!.run({ path: 'src/seq.txt', line_number: 2, content: 'inserted' }, ctx);
    const ilContent = await fs.readFile(path.join(root, 'src', 'seq.txt'), 'utf8');
    check('insert_line が 2 行目に挿入', il.ok && ilContent === 'one\ninserted\ntwo\nthree\n', il.output);
    // insert_line（末尾 = 最終行+1）
    const ilEnd = await getSweTool('insert_line')!.run({ path: 'src/seq.txt', line_number: 5, content: 'four' }, ctx);
    const ilEndContent = await fs.readFile(path.join(root, 'src', 'seq.txt'), 'utf8');
    check('insert_line は末尾（最終行+1）にも挿入可', ilEnd.ok && ilEndContent === 'one\ninserted\ntwo\nthree\nfour\n', ilEnd.output);
    const ilBad = await getSweTool('insert_line')!.run({ path: 'src/seq.txt', line_number: 99, content: 'x' }, ctx);
    check('insert_line は行数超過を拒否', !ilBad.ok, ilBad.output);

    // append_line
    const al = await getSweTool('append_line')!.run({ path: 'src/seq.txt', content: 'five' }, ctx);
    const alContent = await fs.readFile(path.join(root, 'src', 'seq.txt'), 'utf8');
    check('append_line が末尾に追記', al.ok && alContent === 'one\ninserted\ntwo\nthree\nfour\nfive\n', al.output);

    // read_file の行数ヘッダー
    const rHdr = await getSweTool('read_file')!.run({ path: 'src/seq.txt' }, ctx);
    check('read_file が全行数ヘッダーを表示', rHdr.ok && rHdr.output.includes('全 7 行'), rHdr.output.slice(0, 60));

    // ── v1.4: 検索強化（grep_context / find_symbol） ──
    const gc = await getSweTool('grep_context')!.run({ pattern: 'def mul', path: 'src/math.py', context_lines: 1 }, ctx);
    check('grep_context が前後行付きで表示', gc.ok && gc.output.includes('def mul') && gc.output.includes('前後 1 行') && gc.output.includes('return a * b'), gc.output.slice(0, 200));
    const fsym = await getSweTool('find_symbol')!.run({ symbol: 'add', path: 'src' }, ctx);
    check('find_symbol が add の定義行を発見', fsym.ok && fsym.output.includes('src/math.py:1'), fsym.output);
    const fsymAll = await getSweTool('find_symbol')!.run({ path: 'src/math.py' }, ctx);
    check('find_symbol が全定義を列挙', fsymAll.ok && fsymAll.output.includes('def add') && fsymAll.output.includes('def mul'), fsymAll.output);

    // ── v1.4: git 連携（git init → status / diff / revert） ──
    // ここまでの内容（math.py は edit_file テストで変更済み）をコミットしておく
    gitExec(root, ['init', '-q']);
    gitExec(root, ['add', '-A']);
    const commitRes = gitExec(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'initial']);
    const gitAvailable = commitRes.ok;
    if (gitAvailable) {
      const gsClean = await getSweTool('git_status')!.run({}, ctx);
      check('git_status が clean を表示', gsClean.ok && gsClean.output.includes('clean'), gsClean.output);
      // insert_line で変更を加える → git_status / git_diff に現れる
      const il2 = await getSweTool('insert_line')!.run({ path: 'src/math.py', line_number: 2, content: '    # git 差分テスト' }, ctx);
      check('insert_line で変更を加えられる', il2.ok, il2.output);
      const gs = await getSweTool('git_status')!.run({}, ctx);
      check('git_status が変更ファイルを表示', gs.ok && gs.output.includes('src/math.py'), gs.output);
      const gd = await getSweTool('git_diff')!.run({}, ctx);
      check('git_diff が差分を表示', gd.ok && gd.output.includes('+    # git 差分テスト') && gd.output.includes('src/math.py'), gd.output.slice(0, 300));
      const gdPath = await getSweTool('git_diff')!.run({ path: 'src/math.py' }, ctx);
      check('git_diff は path 指定で絞れる', gdPath.ok && gdPath.output.includes('git 差分テスト'), gdPath.output.slice(0, 150));
      // git_revert で変更を破棄
      const gr = await getSweTool('git_revert')!.run({ path: 'src/math.py' }, ctx);
      const reverted = await fs.readFile(path.join(root, 'src', 'math.py'), 'utf8');
      check('git_revert が変更を破棄', gr.ok && !reverted.includes('git 差分テスト') && reverted.includes('return a * b + 1'), gr.output);
      const gsClean2 = await getSweTool('git_status')!.run({}, ctx);
      check('git_revert 後は clean', gsClean2.ok && gsClean2.output.includes('clean'), gsClean2.output);
      // テストファイルの revert は拒否
      const grTest = await getSweTool('git_revert')!.run({ path: 'tests/test_math.py' }, ctx);
      check('git_revert はテストファイルを拒否', !grTest.ok, grTest.output);
    } else {
      console.log('  - git が使えないため git 系テストはスキップ');
    }

    // ── v1.4: run_tests（pytest） ──
    let hasPytest = false;
    try {
      execFileSync('python3', ['-m', 'pytest', '--version'], { stdio: 'ignore' });
      hasPytest = true;
    } catch { /* pytest なし */ }
    if (hasPytest) {
      // run_tests 用に「標準ライブラリと衝突しない」モジュールを用意する。
      // （src/math.py は stdlib の math と衝突するため pytest の import で失敗する）
      await fs.writeFile(
        path.join(root, 'tests', 'conftest.py'),
        'import os\nimport sys\n\nsys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))\n',
        'utf8',
      );
      await fs.writeFile(path.join(root, 'src', 'counter.py'), 'class Counter:\n    def __init__(self):\n        self.n = 0\n\n    def inc(self):\n        self.n += 1\n        return self.n\n', 'utf8');
      await fs.writeFile(path.join(root, 'tests', 'test_counter.py'), 'from counter import Counter\n\n\ndef test_counter():\n    assert Counter().inc() == 1\n', 'utf8');
      const rt = await getSweTool('run_tests')!.run({ target: 'tests/test_counter.py' }, ctx);
      check('run_tests が pytest を実行して成功', rt.ok && rt.output.includes('passed'), rt.output.slice(0, 300));
      const rtBad = await getSweTool('run_tests')!.run({ target: '../escape' }, ctx);
      check('run_tests は root 外 target を拒否', !rtBad.ok, rtBad.output);
    } else {
      console.log('  - pytest が無いため run_tests の成功系はスキップ');
    }

    // ── v1.4: ファイル操作（move_file / delete_file / delete_dir） ──
    const mv = await getSweTool('move_file')!.run({ from: 'src/new.py', to: 'src/moved.py' }, ctx);
    const movedExists = await fs.access(path.join(root, 'src', 'moved.py')).then(() => true).catch(() => false);
    const newGone = await fs.access(path.join(root, 'src', 'new.py')).then(() => false).catch(() => true);
    check('move_file が移動', mv.ok && movedExists && newGone, mv.output);
    const mvOverwrite = await getSweTool('move_file')!.run({ from: 'src/math.py', to: 'src/moved.py' }, ctx);
    check('move_file は上書き先を拒否', !mvOverwrite.ok, mvOverwrite.output);
    const df = await getSweTool('delete_file')!.run({ path: 'src/moved.py' }, ctx);
    const dfGone = await fs.access(path.join(root, 'src', 'moved.py')).then(() => false).catch(() => true);
    check('delete_file が削除', df.ok && dfGone, df.output);
    const dfTest = await getSweTool('delete_file')!.run({ path: 'tests/test_math.py' }, ctx);
    check('delete_file はテストファイルを拒否', !dfTest.ok, dfTest.output);
    // delete_dir（opt-in なし拒否 → opt-in あり成功）
    await fs.mkdir(path.join(root, 'src', 'obsolete'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'obsolete', 'trash.txt'), 'x', 'utf8');
    const ddDenied = await getSweTool('delete_dir')!.run({ path: 'src/obsolete' }, ctx);
    // P2: opt-in なしで「拒否」しつつ、ディレクトリが実際に残っていることも検証する
    const ddStillExists = await fs.access(path.join(root, 'src', 'obsolete')).then(() => true).catch(() => false);
    check('delete_dir は opt-in なしで拒否（ディレクトリは残る）', !ddDenied.ok && ddStillExists, ddDenied.output);
    const ddOk = await getSweTool('delete_dir')!.run({ path: 'src/obsolete' }, { root, allowRunCommand: true });
    const ddGone = await fs.access(path.join(root, 'src', 'obsolete')).then(() => false).catch(() => true);
    check('delete_dir が opt-in で削除', ddOk.ok && ddGone, ddOk.output);
    const ddRoot = await getSweTool('delete_dir')!.run({ path: '.' }, { root, allowRunCommand: true });
    check('delete_dir は root 自体を拒否', !ddRoot.ok, ddRoot.output);
    const ddRootAbs = await getSweTool('delete_dir')!.run({ path: root }, { root, allowRunCommand: true });
    const rootStillExists = await fs.access(root).then(() => true).catch(() => false);
    check('delete_dir は root 絶対パスを拒否（root は残る）', !ddRootAbs.ok && rootStillExists, ddRootAbs.output);
    // P0: 親遡及（..）を含むパスは拒否（sub/.. 等で親ディレクトリを巻き込む削除を防ぐ）
    await fs.mkdir(path.join(root, 'src', 'sub'), { recursive: true });
    const ddDotDot = await getSweTool('delete_dir')!.run({ path: 'src/sub/..' }, { root, allowRunCommand: true });
    const rootStill2 = await fs.access(root).then(() => true).catch(() => false);
    const srcStill = await fs.access(path.join(root, 'src')).then(() => true).catch(() => false);
    check('delete_dir は親遡及（sub/..）を拒否（src は残る）', !ddDotDot.ok && rootStill2 && srcStill, ddDotDot.output);
    const ddGit = await getSweTool('delete_dir')!.run({ path: '.git' }, { root, allowRunCommand: true });
    check('delete_dir は .git を拒否', !ddGit.ok, ddGit.output);

    // 未知ツールは undefined
    check('未知ツールは undefined', getSweTool('nope') === undefined);

    // ailsm_compile（自然言語 → AILSM の検証ツール）
    const ac = await getSweTool('ailsm_compile')!.run({ text: 'x+2=5を解いて' }, ctx);
    check('ailsm_compile が命令列を返す', ac.ok && ac.output.includes('CALL') && ac.output.includes('EQ') && ac.output.includes('検証'), ac.output.slice(0, 200));
    const acEmpty = await getSweTool('ailsm_compile')!.run({ text: '' }, ctx);
    check('ailsm_compile は空入力で拒否', !acEmpty.ok, acEmpty.output);
    const acBad = await getSweTool('ailsm_compile')!.run({ text: 'ふがふがぴよ' }, ctx);
    check('ailsm_compile は解釈不能でヒント付きエラー', !acBad.ok && acBad.output.includes('ヒント'), acBad.output.slice(0, 200));

    // AILSM ガイド（LLM 用説明書の自動生成）
    const guide = buildAilsmGuide();
    check('AILSM ガイドに全カテゴリを含む', ['TASK', 'CONTROL', 'MATH', 'CODE', 'SEARCH', 'REASONING', 'SYSCALL'].every((c) => guide.includes(c)), '');
    check('AILSM ガイドに書き方の例を含む', guide.includes('x+2=5') && guide.includes('TASK_SUMMARIZE'), '');
    const quick = buildAilsmQuickGuide();
    check('AILSM クイックガイドは短い', quick.length < 1200 && quick.includes('ailsm_compile'), `len=${quick.length}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? '✅ ALL PASS — SWE tools' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
