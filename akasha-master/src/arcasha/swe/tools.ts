/**
 * SWE-bench エージェント用のツール群。
 *
 * 提供ツール:
 *   - list_dir    : ディレクトリ一覧（1 段）
 *   - read_file   : ファイル内容の読み取り（行範囲指定可・全行数表示）
 *   - grep_search : テキスト / 正規表現でのファイル内検索（再帰・1 行表示）
 *   - grep_context: 前後行コンテキスト付き検索（grep -C 相当）
 *   - glob_search : パスパターンでのファイル検索（再帰）
 *   - find_symbol : 関数 / クラス等の定義行検索（AST 風の行パターン）
 *   - write_file  : ファイル全体の書き込み（新規 or 上書き）
 *   - edit_file   : 既存ファイル内の文字列を 1 箇所置換
 *   - replace_all : 既存ファイル内の文字列を全箇所置換（occurrence 指定で N 番目のみも可）
 *   - insert_line : 指定行に文字列を挿入
 *   - append_line : ファイル末尾に文字列を追記
 *   - move_file   : ファイル / ディレクトリの移動・リネーム
 *   - delete_file : ファイル削除 / delete_dir: ディレクトリ削除（opt-in）
 *   - run_command : シェルコマンド実行（opt-in・リポジトリ root を cwd にする）
 *   - run_tests   : pytest の実行（コマンド組み立て不要の安全ラッパー）
 *   - git_status  : 作業ツリーの状態表示 / git_diff: 変更差分 / git_revert: ファイル単位で変更を破棄
 *   - ailsm_compile: 自然言語 → AILSM IR の検証
 *
 * 安全策:
 *   - 全パスは root 配下に正規化される（root 外へ出るパスは拒否）。
 *   - run_command は child_process.spawn を使い、タイムアウト・最大出力を設定する。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SweTool, SweContext, SweToolResult, SweToolParameter } from './types.js';
import { compile as ailsmCompile } from '../ailsm/compiler.js';
import { nameOf } from '../ailsa/vocab.js';

/** 出力最大バイト数（LLM コンテキスト保護）。 */
const MAX_OUTPUT_BYTES = 16_000;
/** コマンド実行の既定タイムアウト（ms）。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 検索が辿る最大エントリ数（暴走防止）。 */
const MAX_SEARCH_ENTRIES = 50_000;

/**
 * テストファイルかどうか判定する（SWE-bench ではエージェントはソースのみ修正し、
 * テストは評価時に gold の test_patch で上書きされるため、テストへの書き込みを禁止する）。
 *
 * 注: ディレクトリ判定は `tests`（複数形）のみに限定する。`test`（単数形）は
 * django/test/ のように本番コードのサブパッケージ名として使われることがあるため、
 * ディレクトリ単位ではブロックしない（テストはファイル名パターンと tests/ で捕捉する）。
 */
export function isTestFilePath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  const segments = norm.split('/');
  // tests ディレクトリ配下（複数形）
  if (segments.includes('tests')) return true;
  const base = segments[segments.length - 1] ?? '';
  // テストファイル命名（test.py / tests.py / test_*.py / *_test.py / conftest.py）
  return base === 'test.py' ||
    base === 'tests.py' ||
    /^test_.*\.py$/.test(base) ||
    /^.*_test\.py$/.test(base) ||
    base === 'conftest.py';
}

/** パスがルート相対でテストファイルなら書き込み禁止エラーを返す。 */
async function assertNotTestFile(root: string, p: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await resolveRealInRoot(root, p);
  if (!r.ok) return r;
  // root も realpath 解決してから相対パスを計算（root が symlink の場合は解決後の
  // パスに test/tests 成分が含まれても誤検出しないように）
  let realRoot = root;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    // 解決できない場合は語彙ベースで判定
  }
  const rel = path.relative(realRoot, r.real).replace(/\\/g, '/');
  if (isTestFilePath(rel)) {
    return { ok: false, error: `テストファイルへの書き込みは禁止されています（SWE-bench ではテストは評価時に自動適用されます）: ${p}` };
  }
  return { ok: true };
}

/**
 * realpath ベースで root 配下であることを確認しつつ実パスを返す（唯一のパス解決経路）。
 * symlink 経由で root 外の実体を指すパスは拒否する（安全策）。
 * 実体が存在しない場合は親ディレクトリまで遡って realpath で検証する（新規作成対応）。
 *
 * 注: root 自体も realpath で解決してから比較する（macOS の /var → /private/var 等の
 * symlink で誤判定しないため）。成功時は解決後の root 実体（realRoot）も返す。
 */
async function resolveRealInRoot(root: string, p: string): Promise<{ ok: true; real: string; realRoot: string } | { ok: false; error: string }> {
  // 語彙チェック（symlink 未解決のまま文字列で root 外を拒否）
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const lexRel = path.relative(root, abs);
  if (lexRel.startsWith('..') || path.isAbsolute(lexRel)) {
    return { ok: false, error: `パスはルート外です: ${p}` };
  }

  // root の実体（symlink 解決後）
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return { ok: false, error: `ルート自体を解決できません: ${root}` };
  }

  // 実体（symlink 解決後）が root 配下にあるか確認する
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    // 実体が存在しない → 親ディレクトリの realpath を基準に検証（新規ファイル作成用）
    try {
      const realParent = await fs.realpath(path.dirname(abs));
      const rel = path.relative(realRoot, realParent);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, error: `パスはルート外です（親が symlink で root 外）: ${p}` };
      }
      real = path.join(realParent, path.basename(abs));
    } catch {
      // 親も存在しない → root 実体から相対で解決
      return { ok: true, real: path.join(realRoot, path.relative(root, abs)), realRoot };
    }
  }
  const relReal = path.relative(realRoot, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    return { ok: false, error: `パスはルート外です（symlink 迂回）: ${p}` };
  }
  return { ok: true, real, realRoot };
}

/**
 * 検索対象を「ファイル or ディレクトリ」として走査する。
 * ファイルが指定された場合はその 1 ファイルだけを onFile に渡し、
 * ディレクトリ（または存在しないパス）の場合は walkFiles で再帰走査する。
 */
async function forEachTargetFile(
  targetAbs: string,
  onFile: (abs: string) => Promise<boolean>,
): Promise<void> {
  let st;
  try {
    st = await fs.stat(targetAbs);
  } catch {
    await walkFiles(targetAbs, onFile);
    return;
  }
  if (st.isFile()) {
    await onFile(targetAbs);
  } else {
    await walkFiles(targetAbs, onFile);
  }
}

/** バイト列を最大長で切り詰める（マルチバイト対応で安全に）。 */
function truncate(s: string, max = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let buf = Buffer.from(s, 'utf8');
  buf = buf.subarray(0, max);
  // 途中で切れた UTF-8 シーケンスを除去
  while (buf.length > 0 && (buf[buf.length - 1] & 0b1100_0000) === 0b1000_0000) buf = buf.subarray(0, buf.length - 1);
  return `${buf.toString('utf8')}\n…（出力が長いため切り詰め）`;
}

/** 実行コマンド（shell: false・引数分離）の捕捉結果。 */
interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn 自体の失敗（ENOENT 等）があればメッセージ。 */
  error?: string;
}

/**
 * 引数分離でコマンドを実行して出力を捕捉する（shell: false — インジェクション防止）。
 * git 系ツール・run_tests はこのヘルパーを使う。
 * 各ストリーム（stdout / stderr）は MAX_OUTPUT_BYTES を超えた分を破棄する（メモリ保護）。
 */
function captureSpawn(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stdoutCapped = false;
    let stderrCapped = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += d.toString('utf8');
        if (stdout.length > MAX_OUTPUT_BYTES) { stdout = stdout.slice(0, MAX_OUTPUT_BYTES); stdoutCapped = true; }
      } else {
        stdoutCapped = true;
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += d.toString('utf8');
        if (stderr.length > MAX_OUTPUT_BYTES) { stderr = stderr.slice(0, MAX_OUTPUT_BYTES); stderrCapped = true; }
      } else {
        stderrCapped = true;
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut: false, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 切り詰めた場合は末尾にマーカーを添える
      const sOut = stdoutCapped ? `${stdout}\n…（stdout が長いため切り詰め）` : stdout;
      const sErr = stderrCapped ? `${stderr}\n…（stderr が長いため切り詰め）` : stderr;
      resolve({ code, stdout: sOut, stderr: sErr, timedOut: false });
    });
  });
}

/** captureSpawn の結果を SweToolResult 形式（run_command 互換の表記）へ変換する。 */
function toToolResult(label: string, out: SpawnOutcome, t0: number, emptyNote?: string): SweToolResult {
  if (out.timedOut) {
    return {
      ok: false,
      output: `[タイムアウト] ${label} を強制終了しました。\n--- stdout ---\n${truncate(out.stdout)}\n--- stderr ---\n${truncate(out.stderr)}`,
      ms: Date.now() - t0,
    };
  }
  if (out.error !== undefined) {
    return { ok: false, output: `${label} 起動失敗: ${out.error}`, ms: Date.now() - t0 };
  }
  const body = `${truncate(out.stdout)}${out.stderr ? `\n--- stderr ---\n${truncate(out.stderr)}` : ''}`.trim();
  if (body === '' && emptyNote !== undefined) {
    return { ok: out.code === 0, output: emptyNote, ms: Date.now() - t0 };
  }
  return {
    ok: out.code === 0,
    output: `[exit code ${out.code}]（${Date.now() - t0}ms）\n${body}`,
    ms: Date.now() - t0,
  };
}

/** 再帰探索で無視するディレクトリ名。 */
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.vscode']);

/**
 * root 配下を再帰走査し、ファイルごとに onMatch を呼ぶ。
 * onMatch が true を返すと即時打ち切り（glob 等の上限に使う）。
 * symlink は辿らない（root 外への迂回防止）。
 */
async function walkFiles(root: string, onMatch: (abs: string) => Promise<boolean>): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    // 安定した順序
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (truncated) return;
      if (e.isSymbolicLink()) continue; // symlink は辿らない
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else {
        // 上限ちょうどのファイルも onMatch へ渡してから打ち切る（漏れ防止）
        if (await onMatch(path.join(dir, e.name))) { truncated = true; return; }
        count++;
        if (count > MAX_SEARCH_ENTRIES) { truncated = true; return; }
      }
    }
  }

  await walk(root);
  return { count, truncated };
}

/* ------------------------------------------------------------------ */
/* list_dir                                                            */
/* ------------------------------------------------------------------ */

async function listDir(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const target = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
  const r = await resolveRealInRoot(ctx.root, target);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let entries;
  try {
    entries = await fs.readdir(r.real, { withFileTypes: true });
  } catch (e) {
    return { ok: false, output: `list_dir 失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = entries.map((e) => `${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`);
  const note = `\n（${entries.length} エントリ / ${target}）`;
  return { ok: true, output: truncate(lines.join('\n') + note), ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

async function readFile(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  if (p === '') return { ok: false, output: 'read_file: path が指定されていません', ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let content: string;
  try {
    content = await fs.readFile(r.real, 'utf8');
  } catch (e) {
    return { ok: false, output: `read_file 失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }

  // 行範囲指定（1-indexed・両端含む）
  const startRaw = typeof args.start_line === 'number' ? args.start_line : undefined;
  const endRaw = typeof args.end_line === 'number' ? args.end_line : undefined;
  const lines = content.split('\n');
  const fileNote = `（全 ${lines.length} 行 / ${Buffer.byteLength(content, 'utf8')} bytes）`;
  if (startRaw !== undefined || endRaw !== undefined) {
    const start = startRaw !== undefined ? Math.max(1, Math.floor(startRaw)) : 1;
    const end = endRaw !== undefined ? Math.min(lines.length, Math.floor(endRaw)) : lines.length;
    if (start > end) return { ok: false, output: `read_file: start_line(${start}) > end_line(${end})`, ms: Date.now() - t0 };
    const slice = lines.slice(start - 1, end);
    // 行番号付きで返す
    const numbered = slice.map((l, i) => `${String(start + i).padStart(6)}│ ${l}`).join('\n');
    return { ok: true, output: truncate(`${fileNote}（${start}〜${end} 行目を表示）\n${numbered}`), ms: Date.now() - t0 };
  }
  // 巨大ファイルは先頭 N 行だけ表示する旨を添える
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(6)}│ ${l}`).join('\n');
  return { ok: true, output: truncate(`${fileNote}\n${numbered}`), ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* grep_search                                                         */
/* ------------------------------------------------------------------ */

async function grepSearch(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (pattern === '') return { ok: false, output: 'grep_search: pattern が指定されていません', ms: Date.now() - t0 };

  // 対象パス（省略時は root）
  const target = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
  // symlink 迂回の検証（実体が root 配下にあること）。walk 自体は lexical パスで行う
  // （ctx.root が symlink でも readdir は動作し、相対パスが ctx.root 基準で一貫する）
  const rr = await resolveRealInRoot(ctx.root, target);
  if (!rr.ok) return { ok: false, output: rr.error, ms: Date.now() - t0 };
  const targetAbs = path.isAbsolute(target) ? target : path.resolve(ctx.root, target);

  // 拡張子フィルタ（省略時は全ファイル）
  const ext = typeof args.include === 'string' && args.include !== '' ? args.include : '';

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    return { ok: false, output: `grep_search: 正規表現エラー: ${(e as Error).message}`, ms: Date.now() - t0 };
  }

  const hits: Array<{ rel: string; line: number; text: string }> = [];
  const maxMatches = 200;

  await forEachTargetFile(targetAbs, async (abs) => {
    if (hits.length >= maxMatches) return true; // 打ち切り
    if (ext !== '' && !abs.endsWith(ext)) return false;
    try {
      const st = await fs.stat(abs);
      if (st.size > 1_000_000) return false; // 大きすぎるファイルは読み飛ばし
    } catch { return false; }
    let text: string;
    try { text = await fs.readFile(abs, 'utf8'); } catch { return false; }
    const ls = text.split('\n');
    for (let i = 0; i < ls.length; i++) {
      if (hits.length >= maxMatches) return true;
      // lastIndex を毎行リセットする: g / y フラグ付き正規表現は stateful なため、
      // リセットしないと同じ行を飛ばしてマッチが欠落する（行ごとの検索を保証）。
      regex.lastIndex = 0;
      if (regex.test(ls[i])) {
        hits.push({ rel: path.relative(ctx.root, abs), line: i + 1, text: ls[i].trim().slice(0, 200) });
      }
    }
    return hits.length >= maxMatches;
  });

  const lines = hits.map((h) => `${h.rel}:${h.line}: ${h.text}`);
  const note = hits.length >= maxMatches ? `\n（${maxMatches} 件で打ち切り）` : `\n（${hits.length} 件ヒット）`;
  return { ok: true, output: lines.length > 0 ? truncate(lines.join('\n') + note) : `（0 件）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* glob_search                                                         */
/* ------------------------------------------------------------------ */

async function globSearch(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (pattern === '') return { ok: false, output: 'glob_search: pattern が指定されていません', ms: Date.now() - t0 };

  // シンプルに: **/xxx や *.py を部分一致へ変換（シェルグロブ簡易対応）
  const matcher = (rel: string): boolean => {
    // pattern を正規表現へ
    let re = '';
    for (const ch of pattern) {
      if (ch === '*') re += '.*';
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    try {
      return new RegExp(`^${re}$`).test(rel) || new RegExp(`${re}$`).test(rel);
    } catch { return false; }
  };

  const matches: string[] = [];
  const MAX_GLOB_MATCHES = 500;
  await walkFiles(ctx.root, async (abs) => {
    if (matches.length >= MAX_GLOB_MATCHES) return true;
    const rel = path.relative(ctx.root, abs);
    if (matcher(rel)) matches.push(rel);
    return matches.length >= MAX_GLOB_MATCHES;
  });

  const note = matches.length >= MAX_GLOB_MATCHES ? `\n（${MAX_GLOB_MATCHES} 件で打ち切り）` : `\n（${matches.length} 件）`;
  return { ok: true, output: matches.length > 0 ? truncate(matches.join('\n') + note) : `（0 件）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* write_file                                                          */
/* ------------------------------------------------------------------ */

async function writeFile(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (p === '') return { ok: false, output: 'write_file: path が指定されていません', ms: Date.now() - t0 };
  const guard = await assertNotTestFile(ctx.root, p);
  if (!guard.ok) return { ok: false, output: guard.error, ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  try {
    await fs.mkdir(path.dirname(r.real), { recursive: true });
    await fs.writeFile(r.real, content, 'utf8');
  } catch (e) {
    return { ok: false, output: `write_file 失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `書き込み成功: ${p}（${Buffer.byteLength(content, 'utf8')} bytes）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* edit_file                                                           */
/* ------------------------------------------------------------------ */

async function editFile(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
  const newStr = typeof args.new_string === 'string' ? args.new_string : '';
  if (p === '') return { ok: false, output: 'edit_file: path が指定されていません', ms: Date.now() - t0 };
  if (oldStr === '') return { ok: false, output: 'edit_file: old_string が空です', ms: Date.now() - t0 };
  const guard = await assertNotTestFile(ctx.root, p);
  if (!guard.ok) return { ok: false, output: guard.error, ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let content: string;
  try {
    content = await fs.readFile(r.real, 'utf8');
  } catch (e) {
    return { ok: false, output: `edit_file 読み取り失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    return { ok: false, output: `edit_file: old_string が見つかりません（${p}）。正確な文字列を指定してください。`, ms: Date.now() - t0 };
  }
  const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  try {
    await fs.writeFile(r.real, updated, 'utf8');
  } catch (e) {
    return { ok: false, output: `edit_file 書き込み失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `編集成功: ${p}（1 箇所置換）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* replace_all — 全箇所置換（occurrence 指定で N 番目のみも可）          */
/* ------------------------------------------------------------------ */

async function replaceAll(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
  const newStr = typeof args.new_string === 'string' ? args.new_string : '';
  if (p === '') return { ok: false, output: 'replace_all: path が指定されていません', ms: Date.now() - t0 };
  if (oldStr === '') return { ok: false, output: 'replace_all: old_string が空です', ms: Date.now() - t0 };
  const guard = await assertNotTestFile(ctx.root, p);
  if (!guard.ok) return { ok: false, output: guard.error, ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let content: string;
  try {
    content = await fs.readFile(r.real, 'utf8');
  } catch (e) {
    return { ok: false, output: `replace_all 読み取り失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }

  let updated: string;
  let detail: string;
  const nthRaw = typeof args.occurrence === 'number' ? Math.floor(args.occurrence) : undefined;
  if (nthRaw === undefined) {
    // 全箇所置換
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return { ok: false, output: `replace_all: old_string が見つかりません（${p}）。正確な文字列を指定してください。`, ms: Date.now() - t0 };
    }
    updated = content.split(oldStr).join(newStr);
    detail = `${count} 箇所置換`;
  } else {
    // N 番目（1-indexed）のみ置換。全置換（split/join）と同じく非重複で数えるため、
    // 検索開始位置は前回マッチの末尾（idx + oldStr.length）へ進める。
    const nth = Math.max(1, nthRaw);
    let idx = -1;
    let searchFrom = 0;
    let found = 0;
    for (let i = 0; i < nth; i++) {
      idx = content.indexOf(oldStr, searchFrom);
      if (idx === -1) break;
      found = i + 1;
      searchFrom = idx + oldStr.length;
    }
    if (found < nth) {
      return { ok: false, output: `replace_all: ${nth} 番目の old_string が見つかりません（${p}）。実際の出現は ${found} 箇所です。`, ms: Date.now() - t0 };
    }
    updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    detail = `${nth} 番目のみ置換`;
  }
  try {
    await fs.writeFile(r.real, updated, 'utf8');
  } catch (e) {
    return { ok: false, output: `replace_all 書き込み失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `編集成功: ${p}（${detail}）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* insert_line — 指定行（1-indexed）の前に文字列を挿入                   */
/* ------------------------------------------------------------------ */

async function insertLine(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  const rawLine = typeof args.line_number === 'number' ? Math.floor(args.line_number) : 0;
  const ins = typeof args.content === 'string' ? args.content : '';
  if (p === '') return { ok: false, output: 'insert_line: path が指定されていません', ms: Date.now() - t0 };
  if (rawLine < 1) return { ok: false, output: 'insert_line: line_number は 1 以上（1-indexed）で指定してください', ms: Date.now() - t0 };
  if (ins === '') return { ok: false, output: 'insert_line: content が空です', ms: Date.now() - t0 };
  const guard = await assertNotTestFile(ctx.root, p);
  if (!guard.ok) return { ok: false, output: guard.error, ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let content: string;
  try {
    content = await fs.readFile(r.real, 'utf8');
  } catch (e) {
    return { ok: false, output: `insert_line 読み取り失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  const lines = content.split('\n');
  const total = lines.length;
  if (rawLine > total + 1) {
    return { ok: false, output: `insert_line: line_number(${rawLine}) が行数(${total})を超えています（末尾に追加するなら append_line を使うか、${total + 1} を指定してください）`, ms: Date.now() - t0 };
  }
  const insertAt = rawLine - 1; // この位置（= rawLine 行目）の前に挿入
  const newLines = ins.split('\n');
  lines.splice(insertAt, 0, ...newLines);
  try {
    await fs.writeFile(r.real, lines.join('\n'), 'utf8');
  } catch (e) {
    return { ok: false, output: `insert_line 書き込み失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `挿入成功: ${p}（${rawLine} 行目に ${newLines.length} 行挿入 / 全 ${total + newLines.length} 行）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* append_line — ファイル末尾に文字列を追記                             */
/* ------------------------------------------------------------------ */

async function appendLine(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  const app = typeof args.content === 'string' ? args.content : '';
  if (p === '') return { ok: false, output: 'append_line: path が指定されていません', ms: Date.now() - t0 };
  if (app === '') return { ok: false, output: 'append_line: content が空です', ms: Date.now() - t0 };
  const guard = await assertNotTestFile(ctx.root, p);
  if (!guard.ok) return { ok: false, output: guard.error, ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let content: string;
  try {
    content = await fs.readFile(r.real, 'utf8');
  } catch (e) {
    return { ok: false, output: `append_line 読み取り失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  const prefix = content === '' || content.endsWith('\n') ? '' : '\n';
  const suffix = app.endsWith('\n') ? '' : '\n';
  try {
    await fs.writeFile(r.real, content + prefix + app + suffix, 'utf8');
  } catch (e) {
    return { ok: false, output: `append_line 書き込み失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `追記成功: ${p}（${app.split('\n').length} 行を末尾に追加）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* run_command                                                         */
/* ------------------------------------------------------------------ */

function runCommand(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const command = typeof args.command === 'string' ? args.command : '';
    // シェルインジェクション防止のため、常に「command（実行ファイル名）+ args（引数配列）」で
    // 実行する（shell:false）。シェル機能（パイプ等）が必要な場合は
    //   command: "bash", args: ["-c", "…任意シェル…"]
    // のように明示的にシェルを呼ぶ。args 未指定は単一実行ファイル名として実行する。
    const argList = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === 'string') : [];
    if (command === '') {
      resolvePromise({ ok: false, output: 'run_command: command（実行ファイル名）が空です', ms: Date.now() - t0 });
      return;
    }
    // 安全のための opt-in: allowRunCommand が true のときのみ任意コマンドを実行する
    if (ctx.allowRunCommand !== true) {
      resolvePromise({
        ok: false,
        output: 'run_command は無効です（安全のため opt-in）。実行するには allowRunCommand=true（CLI では --allow-run-command / env ARCASHA_SWE_ALLOW_RUN=1）を設定してください。',
        ms: Date.now() - t0,
      });
      return;
    }
    const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : DEFAULT_TIMEOUT_MS;

    // shell:false で引数分離実行（シェルメタ文字はリテラル引数として扱われ、インジェクションを防ぐ）
    const child = spawn(command, argList, { cwd: ctx.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const out = `[タイムアウト ${Math.floor(timeoutMs / 1000)}s] コマンドを強制終了しました。\n--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}`;
      resolvePromise({ ok: false, output: out, ms: Date.now() - t0 });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, output: `コマンド起動失敗: ${err.message}（command は実行ファイル名・引数は args で渡してください）`, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = `[exit code ${code}]（引数分離実行）（${Date.now() - t0}ms）\n--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}`;
      resolvePromise({ ok: code === 0, output: out, ms: Date.now() - t0 });
    });
  });
}

/* ------------------------------------------------------------------ */
/* git_status — 作業ツリーの状態表示                                    */
/* ------------------------------------------------------------------ */

async function gitStatusTool(_args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const out = await captureSpawn('git', ['status', '--short'], ctx.root, 30_000);
  return toToolResult('git status', out, t0, '（変更なし — 作業ツリーは clean です）');
}

/* ------------------------------------------------------------------ */
/* git_diff — 作業ツリーの変更差分を表示                                */
/* ------------------------------------------------------------------ */

async function gitDiffTool(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' && args.path !== '' ? args.path : null;
  if (p !== null) {
    const r = await resolveRealInRoot(ctx.root, p);
    if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };
    // git は root の実体（realpath 解決後）基準で動くため、realRoot から相対を計算する
    const rel = path.relative(r.realRoot, r.real);
    // path='.' や root 絶対パスは空 pathspec になり git が失敗する → pathspec を省略して全差分を返す
    if (rel === '' || rel === '.') {
      const out = await captureSpawn('git', ['diff', '--no-color'], ctx.root, 30_000);
      return toToolResult('git diff', out, t0, '（変更なし — 作業ツリーに差分はありません）');
    }
    const out = await captureSpawn('git', ['diff', '--no-color', '--', rel], ctx.root, 30_000);
    return toToolResult('git diff', out, t0, `（変更なし: ${p}）`);
  }
  const out = await captureSpawn('git', ['diff', '--no-color'], ctx.root, 30_000);
  return toToolResult('git diff', out, t0, '（変更なし — 作業ツリーに差分はありません）');
}

/* ------------------------------------------------------------------ */
/* git_revert — ファイル単位で作業ツリーの変更を破棄                     */
/* ------------------------------------------------------------------ */

async function gitRevertTool(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  if (p === '') return { ok: false, output: 'git_revert: path が指定されていません', ms: Date.now() - t0 };
  const guard = await assertNotTestFile(ctx.root, p);
  if (!guard.ok) return { ok: false, output: guard.error, ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };
  const rel = path.relative(r.realRoot, r.real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, output: `git_revert: パスはルート外です: ${p}`, ms: Date.now() - t0 };
  }
  // P1 安全策: git_revert は「ファイル単位」のロールバック。ディレクトリを指定すると
  // git restore -- <dir> で中の全変更を一括破棄してしまうため、ディレクトリ指定は拒否する。
  const stat = await fs.stat(r.real).catch(() => null);
  if (stat && stat.isDirectory()) {
    return {
      ok: false,
      output: `git_revert 中止: ${p} はディレクトリです。git_revert はファイル単位のロールバックのみ対応します。` +
        'ディレクトリ内の全変更を破棄する場合は、対象ファイルを個別に指定してください。',
      ms: Date.now() - t0,
    };
  }
  // P1 安全策: エージェント起因でない事前のステージ済み変更（git add 済み）を破棄しないよう、
  // 対象がステージ済みの変更を含む場合は拒否する（git restore はステージ済みも元に戻すため）。
  const staged = await captureSpawn('git', ['diff', '--cached', '--name-only', '--', rel], ctx.root, 15_000);
  if (staged.stdout.trim().length > 0) {
    return {
      ok: false,
      output: `git_revert 中止: ${p} はステージ済み（git add 済み）の変更を含みます。` +
        'git restore はステージ済みの変更も破棄するため、エージェント起因でない編集を失う恐れがあります。' +
        'ステージを解除してから再度実行するか、手動で確認してください。',
      ms: Date.now() - t0,
    };
  }
  const out = await captureSpawn('git', ['restore', '--', rel], ctx.root, 30_000);
  return toToolResult('git restore', out, t0, `変更を破棄しました: ${p}（最終コミットの状態に戻しました）`);
}

/* ------------------------------------------------------------------ */
/* run_tests — pytest の安全ラッパー（コマンド文字列を組まずに実行）     */
/* ------------------------------------------------------------------ */

async function runTestsTool(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const rawTarget = typeof args.target === 'string' ? args.target.trim() : '';
  // P1 安全策: target が '-' で始まる場合、pytest のオプション（--collect-only 等）として
  // 解釈され、意図しない動作や引数注入を招く恐れがあるため拒否する。
  if (rawTarget !== '' && rawTarget.startsWith('-')) {
    return { ok: false, output: 'run_tests: target はファイル / ディレクトリ / node 指定にしてください（"-" で始まる pytest オプションは不可）', ms: Date.now() - t0 };
  }
  // パス指定は root 内に限定（pytest の node 指定「tests/test_x.py::test_y」も許可）。
  // 単語チェックに加え、symlink 迂回で root 外へ出ないよう :: より前のパスを realpath で検証する。
  if (rawTarget !== '') {
    if (rawTarget.startsWith('/') || rawTarget.includes('..')) {
      return { ok: false, output: 'run_tests: target は root 相対で指定してください（../ や絶対パスは不可）', ms: Date.now() - t0 };
    }
    // pytest の node 指定（tests/test_x.py::test_y）からファイルパス部分を取り出す
    const filePart = rawTarget.split('::')[0];
    if (filePart !== '' && filePart !== '.') {
      const rr = await resolveRealInRoot(ctx.root, filePart);
      if (!rr.ok) return { ok: false, output: rr.error, ms: Date.now() - t0 };
    }
  }
  const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
    ? Math.min(600_000, Math.floor(args.timeout_ms))
    : 120_000;

  const argv = ['-m', 'pytest', '-q'];
  if (rawTarget !== '') argv.push(rawTarget);
  const out = await captureSpawn('python3', argv, ctx.root, timeoutMs);
  return toToolResult('pytest', out, t0);
}

/* ------------------------------------------------------------------ */
/* grep_context — 前後行コンテキスト付き検索（grep -C 相当）             */
/* ------------------------------------------------------------------ */

async function grepContext(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (pattern === '') return { ok: false, output: 'grep_context: pattern が指定されていません', ms: Date.now() - t0 };

  const target = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
  const rr = await resolveRealInRoot(ctx.root, target);
  if (!rr.ok) return { ok: false, output: rr.error, ms: Date.now() - t0 };
  const targetAbs = path.isAbsolute(target) ? target : path.resolve(ctx.root, target);

  const ext = typeof args.include === 'string' && args.include !== '' ? args.include : '';
  const ctxLinesRaw = typeof args.context_lines === 'number' ? Math.floor(args.context_lines) : 2;
  const ctxLines = Math.max(0, Math.min(10, ctxLinesRaw));

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    return { ok: false, output: `grep_context: 正規表現エラー: ${(e as Error).message}`, ms: Date.now() - t0 };
  }

  const blocks: string[] = [];
  const maxMatches = 100;

  await forEachTargetFile(targetAbs, async (abs) => {
    if (blocks.length >= maxMatches) return true;
    if (ext !== '' && !abs.endsWith(ext)) return false;
    try {
      const st = await fs.stat(abs);
      if (st.size > 1_000_000) return false;
    } catch { return false; }
    let text: string;
    try { text = await fs.readFile(abs, 'utf8'); } catch { return false; }
    const ls = text.split('\n');
    const rel = path.relative(ctx.root, abs);
    for (let i = 0; i < ls.length; i++) {
      if (blocks.length >= maxMatches) return true;
      regex.lastIndex = 0;
      if (!regex.test(ls[i])) continue;
      const from = Math.max(0, i - ctxLines);
      const to = Math.min(ls.length - 1, i + ctxLines);
      const lines: string[] = [`--- ${rel}:${i + 1}（前後 ${ctxLines} 行） ---`];
      for (let j = from; j <= to; j++) {
        const marker = j === i ? '>' : ' ';
        lines.push(`${marker} ${String(j + 1).padStart(5)}│ ${ls[j].slice(0, 200)}`);
      }
      blocks.push(lines.join('\n'));
      if (blocks.length >= maxMatches) return true;
    }
    return blocks.length >= maxMatches;
  });

  const note = blocks.length >= maxMatches ? `\n（${maxMatches} 件で打ち切り）` : `\n（${blocks.length} 件ヒット）`;
  return { ok: true, output: blocks.length > 0 ? truncate(blocks.join('\n\n') + note) : `（0 件）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* find_symbol — 関数 / クラス等の定義行を検索（言語別の行パターン）      */
/* ------------------------------------------------------------------ */

/** 正規表現エスケープ（symbol をリテラル扱いするため）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 言語別の定義行パターン（ext は絶対パス末尾と照合）。 */
const SYMBOL_RULES: Array<{ ext: RegExp; pattern: RegExp }> = [
  { ext: /\.py$/i, pattern: /^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/ },
  { ext: /\.(ts|tsx|js|jsx|mjs|cjs)$/i, pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type)\s+[A-Za-z_$][\w$]*|^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/ },
  { ext: /\.go$/i, pattern: /^func\s+[A-Za-z_]\w*|^type\s+[A-Za-z_]\w*\s+(?:struct|interface)/ },
  { ext: /\.rs$/i, pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_]\w*|^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+[A-Za-z_]\w*/ },
  { ext: /\.rb$/i, pattern: /^\s*(?:def|class|module)\s+[A-Za-z_]\w*/ },
  { ext: /\.(java|kt)$/i, pattern: /^\s*(?:(?:public|private|protected|static|final|abstract|open|data|sealed|suspend)\s+)*(?:class|interface|enum|fun)\s+[A-Za-z_]\w*/ },
];

async function findSymbol(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const symbol = typeof args.symbol === 'string' && args.symbol.trim() !== '' ? args.symbol.trim() : null;
  const target = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
  const rr = await resolveRealInRoot(ctx.root, target);
  if (!rr.ok) return { ok: false, output: rr.error, ms: Date.now() - t0 };
  const targetAbs = path.isAbsolute(target) ? target : path.resolve(ctx.root, target);

  const symbolRe = symbol !== null ? new RegExp(`\\b${escapeRegExp(symbol)}\\b`) : null;
  const hits: string[] = [];
  const MAX_SYMBOLS = 200;

  await forEachTargetFile(targetAbs, async (abs) => {
    if (hits.length >= MAX_SYMBOLS) return true;
    const rule = SYMBOL_RULES.find((r) => r.ext.test(abs));
    if (!rule) return false;
    try {
      const st = await fs.stat(abs);
      if (st.size > 1_000_000) return false;
    } catch { return false; }
    let text: string;
    try { text = await fs.readFile(abs, 'utf8'); } catch { return false; }
    const ls = text.split('\n');
    const rel = path.relative(ctx.root, abs);
    for (let i = 0; i < ls.length; i++) {
      if (hits.length >= MAX_SYMBOLS) return true;
      if (!rule.pattern.test(ls[i])) continue;
      if (symbolRe !== null && !symbolRe.test(ls[i])) continue;
      hits.push(`${rel}:${i + 1}: ${ls[i].trim().slice(0, 200)}`);
    }
    return hits.length >= MAX_SYMBOLS;
  });

  const what = symbol !== null ? `シンボル「${symbol}」の定義` : '関数 / クラス等の定義';
  const note = hits.length >= MAX_SYMBOLS ? `\n（${MAX_SYMBOLS} 件で打ち切り）` : `\n（${hits.length} 件）`;
  return { ok: true, output: hits.length > 0 ? truncate(`${what}:\n${hits.join('\n')}${note}`) : `（${what}が見つかりません）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* move_file — ファイル / ディレクトリの移動・リネーム                   */
/* ------------------------------------------------------------------ */

async function moveFileTool(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const from = typeof args.from === 'string' ? args.from : '';
  const to = typeof args.to === 'string' ? args.to : '';
  if (from === '') return { ok: false, output: 'move_file: from が指定されていません', ms: Date.now() - t0 };
  if (to === '') return { ok: false, output: 'move_file: to が指定されていません', ms: Date.now() - t0 };
  const guardFrom = await assertNotTestFile(ctx.root, from);
  if (!guardFrom.ok) return { ok: false, output: guardFrom.error, ms: Date.now() - t0 };
  const guardTo = await assertNotTestFile(ctx.root, to);
  if (!guardTo.ok) return { ok: false, output: guardTo.error, ms: Date.now() - t0 };
  const rf = await resolveRealInRoot(ctx.root, from);
  if (!rf.ok) return { ok: false, output: rf.error, ms: Date.now() - t0 };
  const rt = await resolveRealInRoot(ctx.root, to);
  if (!rt.ok) return { ok: false, output: rt.error, ms: Date.now() - t0 };

  // 移動先が既に存在する場合は上書きを拒否（事故防止）
  try {
    await fs.access(rt.real);
    return { ok: false, output: `move_file: 移動先が既に存在します（上書きはしません）: ${to}`, ms: Date.now() - t0 };
  } catch { /* 存在しない → OK */ }

  try {
    await fs.rename(rf.real, rt.real);
  } catch (e) {
    return { ok: false, output: `move_file 失敗: ${(e as Error).message}（移動先の親ディレクトリが存在するか確認してください）`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `移動成功: ${from} → ${to}`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* delete_file — ファイル削除                                          */
/* ------------------------------------------------------------------ */

async function deleteFileTool(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  const p = typeof args.path === 'string' ? args.path : '';
  if (p === '') return { ok: false, output: 'delete_file: path が指定されていません', ms: Date.now() - t0 };
  const guard = await assertNotTestFile(ctx.root, p);
  if (!guard.ok) return { ok: false, output: guard.error, ms: Date.now() - t0 };
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };
  try {
    const st = await fs.stat(r.real);
    if (st.isDirectory()) {
      return { ok: false, output: 'delete_file: ディレクトリは削除できません（delete_dir を使ってください。※危険なため opt-in が必要）', ms: Date.now() - t0 };
    }
    await fs.unlink(r.real);
  } catch (e) {
    return { ok: false, output: `delete_file 失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `削除成功: ${p}`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* delete_dir — ディレクトリ削除（opt-in 必須・.git 等は削除禁止）       */
/* ------------------------------------------------------------------ */

async function deleteDirTool(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  const t0 = Date.now();
  if (ctx.allowRunCommand !== true) {
    return { ok: false, output: 'delete_dir は無効です（危険なため opt-in）。実行するには allowRunCommand=true（CLI では --allow-run-command / env ARCASHA_SWE_ALLOW_RUN=1）を設定してください。', ms: Date.now() - t0 };
  }
  const p = typeof args.path === 'string' ? args.path : '';
  if (p === '' || p === '.' || p === '/') {
    return { ok: false, output: 'delete_dir: root 自体は削除できません。削除するディレクトリを root 相対で指定してください', ms: Date.now() - t0 };
  }
  // 親遡及（..）や絶対パスは拒否（sub/.. 等で親ディレクトリを巻き込む削除を防ぐ）
  if (p.includes('..') || path.isAbsolute(p)) {
    return { ok: false, output: `delete_dir: 親遡及（..）や絶対パスを含むパスは削除できません: ${p}`, ms: Date.now() - t0 };
  }
  const r = await resolveRealInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };
  // P0: 解決後の実体が root そのもの（./ 、sub/..、root 絶対パス等）なら拒否する。
  // 文字列チェックは解決前しか見ないため、realpath 解決後に root と一致しないか必ず検証する。
  if (r.real === r.realRoot) {
    return { ok: false, output: `delete_dir: 指定パスは root 自身に解決されるため削除できません: ${p}`, ms: Date.now() - t0 };
  }
  const rel = path.relative(r.realRoot, r.real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, output: `delete_dir: パスはルート外です: ${p}`, ms: Date.now() - t0 };
  }
  const segments = rel.replace(/\\/g, '/').split('/');
  // テストディレクトリ・重要ディレクトリは削除禁止
  if (segments.includes('tests') || segments.some((s) => IGNORE_DIRS.has(s))) {
    return { ok: false, output: `delete_dir: 削除禁止ディレクトリです（tests または ${[...IGNORE_DIRS].slice(0, 8).join(' / ')} 等）: ${p}`, ms: Date.now() - t0 };
  }
  try {
    await fs.rm(r.real, { recursive: true, force: false });
  } catch (e) {
    return { ok: false, output: `delete_dir 失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `ディレクトリ削除成功: ${p}`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* ailsm_compile — 自然言語 → AILSM の検証ツール                        */
/* ------------------------------------------------------------------ */

async function ailsmCompileTool(args: Record<string, unknown>): Promise<SweToolResult> {
  const t0 = Date.now();
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) {
    return { ok: false, output: 'ailsm_compile: text が空です', ms: Date.now() - t0 };
  }
  try {
    const r = ailsmCompile(text);
    const lines: string[] = [];
    lines.push(`AILSM コンパイル成功（確信度 ${(r.confidence * 100).toFixed(0)}%）`);
    lines.push('');
    lines.push('【AILSA 命令列】（「命令 [スロット="値"]」の並び）:');
    for (const i of r.instructions) {
      const slots = (i.slots ?? [])
        .map((s) => `[${nameOf(s.slot)}="${String(s.value)}"]`)
        .join('');
      lines.push(`  ${nameOf(i.opcode)} ${slots}`.trimEnd());
    }
    lines.push('');
    // compile() は検証に失敗すると throw するため、ここに到達した時点で常に valid
    lines.push('検証: ✅ 有効な命令列です（Verifier 通過）');
    if (r.notes.length > 0) {
      lines.push('');
      lines.push('最適化メモ:');
      for (const n of r.notes) lines.push(`  - ${n}`);
    }
    return { ok: true, output: truncate(lines.join('\n')), ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      output: `AILSM コンパイル失敗: ${msg}\nヒント: 文が曖昧すぎるか、AILSM が解釈できない指示です。より具体的に（何をする・入力は何か）を明示して書き直してください。`,
      ms: Date.now() - t0,
    };
  }
}

/* ------------------------------------------------------------------ */
/* ツール定義一覧                                                       */
/* ------------------------------------------------------------------ */

const param = (p: SweToolParameter): SweToolParameter => p;

const TOOL_PARAMS: Record<string, SweToolParameter[]> = {
  list_dir: [
    param({ name: 'path', type: 'string', description: '一覧するディレクトリ（root 相対 or 絶対）。省略時は root' }),
  ],
  read_file: [
    param({ name: 'path', type: 'string', description: '読み取るファイルパス', required: true }),
    param({ name: 'start_line', type: 'integer', description: '開始行（1-indexed・省略時は先頭）' }),
    param({ name: 'end_line', type: 'integer', description: '終了行（1-indexed・省略時は末尾）' }),
  ],
  grep_search: [
    param({ name: 'pattern', type: 'string', description: '検索する文字列 or 正規表現', required: true }),
    param({ name: 'path', type: 'string', description: '検索対象パス（省略時は root）' }),
    param({ name: 'include', type: 'string', description: '拡張子フィルタ（例: .py）' }),
  ],
  grep_context: [
    param({ name: 'pattern', type: 'string', description: '検索する文字列 or 正規表現', required: true }),
    param({ name: 'path', type: 'string', description: '検索対象パス（省略時は root）' }),
    param({ name: 'context_lines', type: 'integer', description: '一致行の前後に表示する行数（既定 2・最大 10）' }),
    param({ name: 'include', type: 'string', description: '拡張子フィルタ（例: .py）' }),
  ],
  find_symbol: [
    param({ name: 'symbol', type: 'string', description: '探すシンボル名（例: calculate_total）。省略時は定義を全列挙' }),
    param({ name: 'path', type: 'string', description: '検索対象パス / ファイル（省略時は root）' }),
  ],
  glob_search: [
    param({ name: 'pattern', type: 'string', description: 'パスパターン（例: **/*_test.py, */src/*.py）', required: true }),
  ],
  write_file: [
    param({ name: 'path', type: 'string', description: '書き込むファイルパス（新規 or 上書き）', required: true }),
    param({ name: 'content', type: 'string', description: '書き込む内容', required: true }),
  ],
  edit_file: [
    param({ name: 'path', type: 'string', description: '編集するファイルパス', required: true }),
    param({ name: 'old_string', type: 'string', description: '置換対象の文字列（正確に一致必須）', required: true }),
    param({ name: 'new_string', type: 'string', description: '置換後の文字列', required: true }),
  ],
  replace_all: [
    param({ name: 'path', type: 'string', description: '編集するファイルパス', required: true }),
    param({ name: 'old_string', type: 'string', description: '置換対象の文字列（正確に一致必須）', required: true }),
    param({ name: 'new_string', type: 'string', description: '置換後の文字列', required: true }),
    param({ name: 'occurrence', type: 'integer', description: '省略時は全箇所置換。N を指定すると N 番目（1-indexed）のみ置換' }),
  ],
  insert_line: [
    param({ name: 'path', type: 'string', description: '編集するファイルパス', required: true }),
    param({ name: 'line_number', type: 'integer', description: '挿入位置（1-indexed。この行の前に挿入。最終行+1 で末尾挿入）', required: true }),
    param({ name: 'content', type: 'string', description: '挿入する内容（複数行は改行区切りで可）', required: true }),
  ],
  append_line: [
    param({ name: 'path', type: 'string', description: '編集するファイルパス', required: true }),
    param({ name: 'content', type: 'string', description: '末尾に追記する内容', required: true }),
  ],
  move_file: [
    param({ name: 'from', type: 'string', description: '移動元パス（ファイル or ディレクトリ）', required: true }),
    param({ name: 'to', type: 'string', description: '移動先パス（リネームも可）。既存ファイルは上書きしない', required: true }),
  ],
  delete_file: [
    param({ name: 'path', type: 'string', description: '削除するファイルパス', required: true }),
  ],
  delete_dir: [
    param({ name: 'path', type: 'string', description: '削除するディレクトリパス（root 自体・tests・.git 等は削除不可）', required: true }),
  ],
  run_command: [
    param({ name: 'command', type: 'string', description: '実行ファイル名（例: "python3", "bash", "git"）。シェルメタ文字を含めない。シェル機能が必要なら command="bash" を指定', required: true }),
    param({ name: 'args', type: 'array', items: 'string', description: '実行ファイルへ渡す引数配列（例: ["-c", "print(42)"]）。シェルを介さず引数分離で実行される', required: true }),
    param({ name: 'timeout_ms', type: 'integer', description: 'タイムアウト（ms）' }),
  ],
  run_tests: [
    param({ name: 'target', type: 'string', description: 'テスト対象（省略時は root）。例: tests/test_math.py や tests/test_math.py::test_add' }),
    param({ name: 'timeout_ms', type: 'integer', description: 'タイムアウト（ms・既定 120000・最大 600000）' }),
  ],
  git_status: [],
  git_diff: [
    param({ name: 'path', type: 'string', description: '差分を見るファイル / ディレクトリ（省略時は全変更）' }),
  ],
  git_revert: [
    param({ name: 'path', type: 'string', description: '変更を破棄するファイル（最終コミットの状態へ戻す）', required: true }),
  ],
  ailsm_compile: [
    param({ name: 'text', type: 'string', description: 'AILSM に変換したい自然言語の指示（日本語で OK）', required: true }),
  ],
};

/** 全ツールの定義。 */
export const SWE_TOOLS: SweTool[] = [
  {
    name: 'list_dir',
    description: 'ディレクトリ内のファイル / サブディレクトリを 1 段表示する。リポジトリ構造の把握に使う。',
    parameters: TOOL_PARAMS.list_dir,
    run: listDir,
  },
  {
    name: 'read_file',
    description: 'ファイルの内容を読み取る（行番号付き・全行数付き）。start_line / end_line で行範囲を指定できる。',
    parameters: TOOL_PARAMS.read_file,
    run: readFile,
  },
  {
    name: 'grep_search',
    description: 'リポジトリ内のファイルを再帰検索し、文字列 / 正規表現に一致する行を返す（1 行のみ・文脈が要る場合は grep_context）。include で拡張子を絞れる。',
    parameters: TOOL_PARAMS.grep_search,
    run: grepSearch,
  },
  {
    name: 'grep_context',
    description: '一致行の前後 N 行（コンテキスト）を付けて検索する（grep -C 相当）。関数の実装周辺を把握したいとき等に使う。',
    parameters: TOOL_PARAMS.grep_context,
    run: grepContext,
  },
  {
    name: 'glob_search',
    description: 'パスパターン（**/*_test.py 等）でファイルを再帰検索する。',
    parameters: TOOL_PARAMS.glob_search,
    run: globSearch,
  },
  {
    name: 'find_symbol',
    description: '関数 / クラス / インターフェース等の定義行を検索する（Python / TS / JS / Go / Rust / Ruby / Java / Kotlin 対応）。symbol 名を指定するとその定義だけを返す。',
    parameters: TOOL_PARAMS.find_symbol,
    run: findSymbol,
  },
  {
    name: 'write_file',
    description: 'ファイルを新規作成 / 上書きする（内容全体を置き換え）。',
    parameters: TOOL_PARAMS.write_file,
    run: writeFile,
  },
  {
    name: 'edit_file',
    description: '既存ファイル内の old_string を new_string に置換する（最初の 1 箇所のみ）。全箇所置換は replace_all を使う。',
    parameters: TOOL_PARAMS.edit_file,
    run: editFile,
  },
  {
    name: 'replace_all',
    description: '既存ファイル内の old_string を new_string に全箇所置換する。occurrence に N を指定すると N 番目（1-indexed）のみ置換（replace_nth 相当）。',
    parameters: TOOL_PARAMS.replace_all,
    run: replaceAll,
  },
  {
    name: 'insert_line',
    description: '既存ファイルの指定行（1-indexed）の前に文字列を挿入する。末尾に追加したい場合は append_line を使う。',
    parameters: TOOL_PARAMS.insert_line,
    run: insertLine,
  },
  {
    name: 'append_line',
    description: '既存ファイルの末尾に文字列を追記する。',
    parameters: TOOL_PARAMS.append_line,
    run: appendLine,
  },
  {
    name: 'move_file',
    description: 'ファイル / ディレクトリを移動・リネームする（root 内のみ・移動先が既存なら拒否）。リファクタリングのファイル移動に使う。',
    parameters: TOOL_PARAMS.move_file,
    run: moveFileTool,
  },
  {
    name: 'delete_file',
    description: 'ファイルを削除する（テストファイルは削除不可）。',
    parameters: TOOL_PARAMS.delete_file,
    run: deleteFileTool,
  },
  {
    name: 'delete_dir',
    description: 'ディレクトリを再帰削除する（危険なため opt-in でのみ有効。tests / .git / node_modules 等と root 自体は削除不可）。',
    parameters: TOOL_PARAMS.delete_dir,
    run: deleteDirTool,
  },
  {
    name: 'run_command',
    description: 'コマンドをリポジトリ root を cwd に実行する。シェルインジェクション防止のため引数分離実行（shell:false）。command は実行ファイル名、args は引数配列を指定する。シェル機能（パイプ等）が必要な場合は command="bash", args=["-c", "…任意シェル…"] と明示する。※安全のため opt-in（allowRunCommand=true / env ARCASHA_SWE_ALLOW_RUN=1 / CLI --allow-run-command）でのみ有効。テスト実行は run_tests が便利。',
    parameters: TOOL_PARAMS.run_command,
    run: runCommand,
  },
  {
    name: 'run_tests',
    description: 'pytest を実行する（python3 -m pytest -q）。コマンド文字列を組む必要がなく安全。target にテストファイル / ディレクトリ / node 指定（tests/test_x.py::test_y）を渡せる。',
    parameters: TOOL_PARAMS.run_tests,
    run: runTestsTool,
  },
  {
    name: 'git_status',
    description: '作業ツリーの変更状態を表示する（git status --short 相当。変更 / 追加 / 削除されたファイル一覧）。',
    parameters: TOOL_PARAMS.git_status,
    run: gitStatusTool,
  },
  {
    name: 'git_diff',
    description: '作業ツリーの変更差分を表示する（git diff 相当）。path を指定するとそのファイル / ディレクトリの差分のみ。編集前に意図通りか確認するのに使う。',
    parameters: TOOL_PARAMS.git_diff,
    run: gitDiffTool,
  },
  {
    name: 'git_revert',
    description: '指定ファイルの作業ツリー変更を破棄して最終コミットの状態に戻す（git restore 相当・ファイル単位）。誤った編集のロールバックに使う。',
    parameters: TOOL_PARAMS.git_revert,
    run: gitRevertTool,
  },
  {
    name: 'ailsm_compile',
    description: '自然言語の指示を AILSM（ArcAsha の型付き中間言語）にコンパイルし、生成された AILSA 命令列（オペコード名 + スロット）と検証結果を返す。自分の理解が正しいかを検証するのに使う。ファイルは変更しない。',
    parameters: TOOL_PARAMS.ailsm_compile,
    run: ailsmCompileTool,
  },
];

/** ツール名 → 実装のルックアップ。 */
export function getSweTool(name: string): SweTool | undefined {
  return SWE_TOOLS.find((t) => t.name === name);
}
