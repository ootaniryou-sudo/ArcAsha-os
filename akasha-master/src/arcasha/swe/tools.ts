/**
 * SWE-bench エージェント用のツール群。
 *
 * 提供ツール:
 *   - list_dir   : ディレクトリ一覧（1 段）
 *   - read_file  : ファイル内容の読み取り（行範囲指定可）
 *   - grep_search: テキスト / 正規表現でのファイル内検索（再帰）
 *   - glob_search: パスパターンでのファイル検索（再帰）
 *   - write_file : ファイル全体の書き込み（新規 or 上書き）
 *   - edit_file  : 既存ファイル内の文字列を置換（apply edit）
 *   - run_command: シェルコマンド実行（リポジトリ root を cwd にする）
 *
 * 安全策:
 *   - 全パスは root 配下に正規化される（root 外へ出るパスは拒否）。
 *   - run_command は child_process.spawn を使い、タイムアウト・最大出力を設定する。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SweTool, SweContext, SweToolResult, SweToolParameter } from './types.js';

/** 出力最大バイト数（LLM コンテキスト保護）。 */
const MAX_OUTPUT_BYTES = 16_000;
/** コマンド実行の既定タイムアウト（ms）。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 検索が辿る最大エントリ数（暴走防止）。 */
const MAX_SEARCH_ENTRIES = 50_000;

/** root 配下の絶対パスへ解決し、root 外ならエラーにする。 */
function resolveInRoot(root: string, p: string): { ok: true; abs: string } | { ok: false; error: string } {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `パスはルート外です: ${p}` };
  }
  return { ok: true, abs };
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

/** 再帰探索で無視するディレクトリ名。 */
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.vscode']);

async function collectEntries(root: string, opts: {
  /** ディレクトリを返すか */
  includeDirs?: boolean;
  /** マッチしたパスを返す（true なら callback のみで再帰は止める） */
  maxEntries?: number;
}, onMatch: (abs: string) => boolean): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  let truncated = false;
  const max = opts.maxEntries ?? MAX_SEARCH_ENTRIES;

  async function walk(dir: string): Promise<void> {
    if (truncated || count >= max) { truncated = true; return; }
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    // 安定した順序
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (truncated || count >= max) { truncated = true; return; }
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (opts.includeDirs !== false) {
          count++;
          if (onMatch(path.join(dir, e.name))) continue; // マッチしたらこの dir は深追いしない（includeDirs 用）
        }
        await walk(path.join(dir, e.name));
      } else {
        count++;
        onMatch(path.join(dir, e.name));
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
  const r = resolveInRoot(ctx.root, target);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let entries;
  try {
    entries = await fs.readdir(r.abs, { withFileTypes: true });
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
  const r = resolveInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let content: string;
  try {
    content = await fs.readFile(r.abs, 'utf8');
  } catch (e) {
    return { ok: false, output: `read_file 失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }

  // 行範囲指定（1-indexed・両端含む）
  const startRaw = typeof args.start_line === 'number' ? args.start_line : undefined;
  const endRaw = typeof args.end_line === 'number' ? args.end_line : undefined;
  const lines = content.split('\n');
  if (startRaw !== undefined || endRaw !== undefined) {
    const start = startRaw !== undefined ? Math.max(1, Math.floor(startRaw)) : 1;
    const end = endRaw !== undefined ? Math.min(lines.length, Math.floor(endRaw)) : lines.length;
    if (start > end) return { ok: false, output: `read_file: start_line(${start}) > end_line(${end})`, ms: Date.now() - t0 };
    const slice = lines.slice(start - 1, end);
    // 行番号付きで返す
    const numbered = slice.map((l, i) => `${String(start + i).padStart(6)}│ ${l}`).join('\n');
    return { ok: true, output: truncate(numbered), ms: Date.now() - t0 };
  }
  // 巨大ファイルは先頭 N 行だけ表示する旨を添える
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(6)}│ ${l}`).join('\n');
  return { ok: true, output: truncate(numbered), ms: Date.now() - t0 };
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
  const r = resolveInRoot(ctx.root, target);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

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

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (hits.length >= maxMatches) return;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else {
        const abs = path.join(dir, e.name);
        if (ext !== '' && !abs.endsWith(ext)) continue;
        try {
          const st = await fs.stat(abs);
          if (st.size > 1_000_000) continue; // 大きすぎるファイルは読み飛ばし
        } catch { continue; }
        let text: string;
        try { text = await fs.readFile(abs, 'utf8'); } catch { continue; }
        const ls = text.split('\n');
        for (let i = 0; i < ls.length; i++) {
          if (hits.length >= maxMatches) return;
          if (regex.test(ls[i])) {
            hits.push({ rel: path.relative(ctx.root, abs), line: i + 1, text: ls[i].trim().slice(0, 200) });
          }
        }
      }
    }
  }

  await walk(r.abs);

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
  await collectEntries(ctx.root, { includeDirs: false }, (abs) => {
    if (matches.length >= 500) return true;
    const rel = path.relative(ctx.root, abs);
    if (matcher(rel)) matches.push(rel);
    return false;
  });

  const note = matches.length >= 500 ? `\n（500 件で打ち切り）` : `\n（${matches.length} 件）`;
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
  const r = resolveInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  try {
    await fs.mkdir(path.dirname(r.abs), { recursive: true });
    await fs.writeFile(r.abs, content, 'utf8');
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
  const r = resolveInRoot(ctx.root, p);
  if (!r.ok) return { ok: false, output: r.error, ms: Date.now() - t0 };

  let content: string;
  try {
    content = await fs.readFile(r.abs, 'utf8');
  } catch (e) {
    return { ok: false, output: `edit_file 読み取り失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    return { ok: false, output: `edit_file: old_string が見つかりません（${p}）。正確な文字列を指定してください。`, ms: Date.now() - t0 };
  }
  const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  try {
    await fs.writeFile(r.abs, updated, 'utf8');
  } catch (e) {
    return { ok: false, output: `edit_file 書き込み失敗: ${(e as Error).message}`, ms: Date.now() - t0 };
  }
  return { ok: true, output: `編集成功: ${p}（1 箇所置換）`, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* run_command                                                         */
/* ------------------------------------------------------------------ */

function runCommand(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult> {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const command = typeof args.command === 'string' ? args.command : '';
    if (command === '') {
      resolvePromise({ ok: false, output: 'run_command: command が空です', ms: Date.now() - t0 });
      return;
    }
    const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : DEFAULT_TIMEOUT_MS;

    const child = spawn(command, { cwd: ctx.root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      resolvePromise({ ok: false, output: `コマンド起動失敗: ${err.message}`, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = `[exit code ${code}]（${Date.now() - t0}ms）\n--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}`;
      resolvePromise({ ok: code === 0, output: out, ms: Date.now() - t0 });
    });
  });
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
    param({ name: 'path', type: 'string', description: '読み取るファイルパス（必須）' }),
    param({ name: 'start_line', type: 'integer', description: '開始行（1-indexed・省略時は先頭）' }),
    param({ name: 'end_line', type: 'integer', description: '終了行（1-indexed・省略時は末尾）' }),
  ],
  grep_search: [
    param({ name: 'pattern', type: 'string', description: '検索する文字列 or 正規表現（必須）' }),
    param({ name: 'path', type: 'string', description: '検索対象パス（省略時は root）' }),
    param({ name: 'include', type: 'string', description: '拡張子フィルタ（例: .py）' }),
  ],
  glob_search: [
    param({ name: 'pattern', type: 'string', description: 'パスパターン（例: **/*_test.py, */src/*.py）' }),
  ],
  write_file: [
    param({ name: 'path', type: 'string', description: '書き込むファイルパス（必須・新規 or 上書き）' }),
    param({ name: 'content', type: 'string', description: '書き込む内容（必須）' }),
  ],
  edit_file: [
    param({ name: 'path', type: 'string', description: '編集するファイルパス（必須）' }),
    param({ name: 'old_string', type: 'string', description: '置換対象の文字列（正確に一致必須）' }),
    param({ name: 'new_string', type: 'string', description: '置換後の文字列' }),
  ],
  run_command: [
    param({ name: 'command', type: 'string', description: '実行するシェルコマンド（root を cwd に実行）' }),
    param({ name: 'timeout_ms', type: 'integer', description: 'タイムアウト（ms）' }),
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
    description: 'ファイルの内容を読み取る（行番号付き）。start_line / end_line で行範囲を指定できる。',
    parameters: TOOL_PARAMS.read_file,
    run: readFile,
  },
  {
    name: 'grep_search',
    description: 'リポジトリ内のファイルを再帰検索し、文字列 / 正規表現に一致する行を返す。include で拡張子を絞れる。',
    parameters: TOOL_PARAMS.grep_search,
    run: grepSearch,
  },
  {
    name: 'glob_search',
    description: 'パスパターン（**/*_test.py 等）でファイルを再帰検索する。',
    parameters: TOOL_PARAMS.glob_search,
    run: globSearch,
  },
  {
    name: 'write_file',
    description: 'ファイルを新規作成 / 上書きする（内容全体を置き換え）。',
    parameters: TOOL_PARAMS.write_file,
    run: writeFile,
  },
  {
    name: 'edit_file',
    description: '既存ファイル内の old_string を new_string に置換する（1 箇所）。old_string は正確に一致させること。',
    parameters: TOOL_PARAMS.edit_file,
    run: editFile,
  },
  {
    name: 'run_command',
    description: 'シェルコマンドをリポジトリ root をカレントディレクトリとして実行する。テスト実行（pytest 等）やビルドに使う。',
    parameters: TOOL_PARAMS.run_command,
    run: runCommand,
  },
];

/** ツール名 → 実装のルックアップ。 */
export function getSweTool(name: string): SweTool | undefined {
  return SWE_TOOLS.find((t) => t.name === name);
}
