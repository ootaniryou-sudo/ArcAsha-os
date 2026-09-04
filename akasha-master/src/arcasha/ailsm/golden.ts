/**
 * AILSM Golden Test — コンパイラの回帰テスト（ABI 安定性の証拠）
 *
 * 入力（自然言語）→ 期待（意図/ドメイン/アクション/オブジェクト/属性/出力/オペコード/ノート）
 * をケース表で管理する。ケースを追加するだけで 100〜1000 件規模へスケールできる。
 *
 * 実行: npx tsx src/arcasha/ailsm/golden.ts
 */

import { compile } from './compiler.js';
import { CodeOpcode, MathOpcode } from '../ailsa/dialect.js';
import { Task } from '../ailsa/vocab.js';

export interface GoldenExpect {
  intent?: string;
  domain?: string;
  actions?: string[];
  objects?: string[];
  attributes?: { name: string; value: string }[];
  output?: string | null;
  throwError?: boolean;
  opcodes?: number[];
  notOpcodes?: number[];
  notes?: string[];
}

export interface GoldenCase {
  name: string;
  input: string;
  expect: GoldenExpect;
}

export const GOLDEN_CASES: GoldenCase[] = [
  // ── 方程式 ──
  { name: 'solve-linear', input: 'x+2=5を解いて', expect: { intent: 'solve', domain: 'math', opcodes: [Task.SOLVE] } },
  { name: 'solve-linear2', input: '2x-3=1を解け', expect: { intent: 'solve', domain: 'math' } },
  { name: 'solve-quad', input: 'x^2-4=0を計算して', expect: { intent: 'solve', domain: 'math' } },
  { name: 'solve-english', input: 'solve x+2=5', expect: { intent: 'solve', domain: 'math' } },

  // ── 図形 ──
  { name: 'circle-area', input: '半径3の円の面積を求めて', expect: { intent: 'solve', domain: 'math', objects: ['circle'], attributes: [{ name: 'radius', value: '3' }], output: 'area' } },
  { name: 'circle-perimeter', input: '直径6の円の周囲を求めよ', expect: { intent: 'solve', domain: 'math', objects: ['circle'], attributes: [{ name: 'diameter', value: '6' }], output: 'perimeter' } },
  { name: 'square-area', input: '一辺4の正方形の面積を求めて', expect: { intent: 'solve', domain: 'math', objects: ['square'], attributes: [{ name: 'side', value: '4' }], output: 'area' } },
  { name: 'triangle', input: '三角形の面積を計算して', expect: { intent: 'solve', domain: 'math', objects: ['triangle'] } },

  // ── 四則演算（同義語の正準化） ──
  { name: 'add-syn1', input: '足してください', expect: { domain: 'math', actions: ['ACTION_ADD'] } },
  { name: 'add-syn2', input: '加えて', expect: { domain: 'math', actions: ['ACTION_ADD'] } },
  { name: 'add-syn3', input: '和を求めよ', expect: { intent: 'solve', domain: 'math', actions: ['ACTION_ADD'] } },
  { name: 'subtract', input: '10から4を引いて', expect: { domain: 'math', actions: ['ACTION_SUBTRACT'] } },
  { name: 'multiply', input: '7と6を掛けて', expect: { domain: 'math', actions: ['ACTION_MULTIPLY'] } },
  { name: 'divide', input: '20を4で割って', expect: { domain: 'math', actions: ['ACTION_DIVIDE'] } },
  { name: 'sqrt', input: '9の平方根を求めて', expect: { intent: 'solve', domain: 'math', actions: ['ACTION_SQRT'] } },

  // ── 数学方言オペコード ──
  { name: 'integral', input: 'x^2を積分して', expect: { intent: 'solve', domain: 'math', actions: ['ACTION_INTEGRAL'], opcodes: [MathOpcode.INTEGRAL] } },
  { name: 'derive', input: 'x^3を微分して', expect: { intent: 'solve', domain: 'math', actions: ['ACTION_DERIVE'], opcodes: [MathOpcode.DERIVE] } },
  { name: 'derive-syn', input: 'x^2+1の導関数を求めよ', expect: { intent: 'solve', domain: 'math', actions: ['ACTION_DERIVE'], opcodes: [MathOpcode.DERIVE] } },
  { name: 'limit', input: '関数の極限を求めて', expect: { intent: 'solve', domain: 'math', actions: ['ACTION_LIMIT'] } },
  { name: 'matrix', input: '行列の積を計算して', expect: { intent: 'solve', domain: 'math', objects: ['matrix'], actions: ['ACTION_MATRIX'] } },

  // ── 非数学タスク ──
  { name: 'summarize', input: 'この文章を要約して', expect: { intent: 'summarize', domain: 'reasoning', opcodes: [Task.SUMMARIZE] } },
  { name: 'summarize-syn', input: '文章をまとめて', expect: { intent: 'summarize', domain: 'reasoning' } },
  { name: 'search', input: 'Webで記事を検索して', expect: { intent: 'search', domain: 'search' } },
  { name: 'verify', input: '結果を検証して', expect: { intent: 'verify', domain: 'reasoning' } },
  { name: 'code', input: 'コードのバグを修正して', expect: { intent: 'code', domain: 'code' } },

  // ── コードファイル操作（SWE: GREP / READ_FILE / EDIT_FILE / RUN_COMMAND、registry v1.3.0） ──
  { name: 'swe-grep', input: 'コードを検索して', expect: { intent: 'search', domain: 'code', actions: ['ACTION_GREP'], opcodes: [CodeOpcode.GREP] } },
  { name: 'swe-grep-syn', input: 'ソースを探して', expect: { domain: 'code', actions: ['ACTION_GREP'], opcodes: [CodeOpcode.GREP] } },
  { name: 'swe-grep-en', input: 'grep TODO in tools', expect: { domain: 'code', actions: ['ACTION_GREP'], opcodes: [CodeOpcode.GREP] } },
  { name: 'swe-read', input: 'src/arcasha/swe/tools.ts を読んで', expect: { domain: 'code', actions: ['ACTION_READ_FILE'], opcodes: [CodeOpcode.READ_FILE] } },
  { name: 'swe-edit', input: 'tools.ts のバグを修正して', expect: { intent: 'code', domain: 'code', actions: ['ACTION_EDIT_FILE'], opcodes: [CodeOpcode.EDIT_FILE] } },
  // v1.4.0: テスト実行は専用 RUN_TESTS（汎用 RUN_COMMAND から独立）
  { name: 'swe-run', input: 'テストを実行して', expect: { domain: 'code', actions: ['ACTION_RUN_TESTS'], opcodes: [CodeOpcode.RUN_TESTS, Task.VERIFY] } },
  // 誤爆ガード: 要約が目的の文は、読みの語を含んでいても reasoning のまま（code 命令を出さない）
  { name: 'swe-read-guard', input: 'このファイルを読んで要約して', expect: { intent: 'summarize', domain: 'reasoning', notOpcodes: [CodeOpcode.READ_FILE] } },
  // 誤爆ガード: Web 検索は code ドメインへ倒さない
  { name: 'swe-grep-guard', input: 'Webで記事を検索して', expect: { intent: 'search', domain: 'search', notOpcodes: [CodeOpcode.GREP] } },

  // ── v1.4.0: Git / テスト / 編集細分化 / ファイル操作 / 検索強化 ──
  { name: 'swe-git-diff', input: '変更差分を確認して', expect: { domain: 'code', actions: ['ACTION_GIT_DIFF'], opcodes: [CodeOpcode.GIT_DIFF, Task.VERIFY] } },
  { name: 'swe-replace-all', input: 'ファイル内の TODO を全置換して', expect: { domain: 'code', actions: ['ACTION_REPLACE_ALL'], opcodes: [CodeOpcode.REPLACE_ALL, Task.PATCH] } },
  { name: 'swe-move', input: 'src/a.ts を lib/b.ts にファイルを移動して', expect: { domain: 'code', actions: ['ACTION_MOVE_FILE'], opcodes: [CodeOpcode.MOVE_FILE, Task.PATCH] } },
  { name: 'swe-delete', input: 'src/old.ts をファイル削除して', expect: { domain: 'code', actions: ['ACTION_DELETE_FILE'], opcodes: [CodeOpcode.DELETE_FILE, Task.PATCH] } },
  { name: 'swe-insert', input: 'src/main.ts の10行目に行を挿入して', expect: { domain: 'code', actions: ['ACTION_INSERT_LINE'], opcodes: [CodeOpcode.INSERT_LINE, Task.PATCH] } },
  { name: 'swe-find-symbol', input: 'runSweAgent の定義を検索して', expect: { domain: 'code', actions: ['ACTION_FIND_SYMBOL'], opcodes: [CodeOpcode.FIND_SYMBOL, Task.SEARCH] } },

  // ── レビュー指摘の回帰（lexer / normalizer / generator の誤判定修正） ──
  // 汎用の「を読んで」はファイル文脈なしでは code へ倒さない（数学解釈を維持）
  { name: 'read-noctx-math', input: '問題を読んで解いて', expect: { intent: 'solve', domain: 'math', notOpcodes: [CodeOpcode.READ_FILE] } },
  // パス文脈ありは READ_FILE
  { name: 'read-path-context', input: 'src/main.ts を読んで', expect: { intent: 'code', domain: 'code', actions: ['ACTION_READ_FILE'], opcodes: [CodeOpcode.READ_FILE, Task.SEARCH] } },
  // verify + 数式は math を維持（Capability 検証で throw しない）
  { name: 'verify-math', input: 'x+2=5を確認して', expect: { intent: 'verify', domain: 'math', opcodes: [MathOpcode.EQ, Task.VERIFY] } },
  // 小数除算は math（lexer がパスと誤判定しない）
  { name: 'divide-decimal', input: '2/3.14を計算して', expect: { intent: 'solve', domain: 'math', notOpcodes: [CodeOpcode.READ_FILE] } },
  // code アクションのタスク選択: READ は TASK_SEARCH（TASK_PATCH/SOLVE に誤分類しない）
  { name: 'read-task-search', input: 'src/main.ts を読んで', expect: { opcodes: [Task.SEARCH], notOpcodes: [Task.PATCH] } },

  // ── Constant Folding（定数畳み込み） ──
  {
    name: 'constant-fold',
    input: '2+3を計算して',
    expect: {
      intent: 'solve',
      domain: 'math',
      notes: ['constant fold: 2+3 = 5'],
      notOpcodes: [MathOpcode.EQ],
    },
  },
  { name: 'constant-fold-div', input: '10/2を計算して', expect: { domain: 'math', notes: ['constant fold'] } },

  // ── 失敗系（壊れない土台 / Stage 2 委譲点） ──
  { name: 'empty', input: '', expect: { throwError: true } },
  { name: 'uninterpretable', input: 'こんにちは世界', expect: { throwError: true } },
  { name: 'uninterpretable-en', input: 'hello world', expect: { throwError: true } },
];

export function runGolden(cases: GoldenCase[] = GOLDEN_CASES): number {
  let failed = 0;
  for (const c of cases) {
    try {
      const r = compile(c.input);
      const e = c.expect;
      const problems: string[] = [];
      if (e.throwError) {
        problems.push('例外が投げられるべき');
      } else {
        if (e.intent !== undefined && r.normalized.intent !== e.intent) {
          problems.push(`intent=${r.normalized.intent}（期待 ${e.intent}）`);
        }
        if (e.domain !== undefined && r.normalized.domain !== e.domain) {
          problems.push(`domain=${r.normalized.domain}（期待 ${e.domain}）`);
        }
        if (e.actions !== undefined && !e.actions.every((a) => r.normalized.actions.includes(a as never))) {
          problems.push(`actions=${r.normalized.actions.join(',')}（期待 ${e.actions.join(',')}）`);
        }
        if (e.objects !== undefined && !e.objects.every((o) => r.normalized.objects.includes(o))) {
          problems.push(`objects=${r.normalized.objects.join(',')}（期待 ${e.objects.join(',')}）`);
        }
        if (
          e.attributes !== undefined &&
          !e.attributes.every((a) => r.normalized.attributes.some((x) => x.name === a.name && x.value === a.value))
        ) {
          problems.push(`attributes=${JSON.stringify(r.normalized.attributes)}`);
        }
        if (e.output !== undefined && r.normalized.output !== e.output) {
          problems.push(`output=${r.normalized.output}（期待 ${e.output}）`);
        }
        if (e.opcodes !== undefined && !e.opcodes.every((op) => r.instructions.some((i) => i.opcode === op))) {
          problems.push(`opcodes 欠落（期待 ${e.opcodes.map((o) => `0x${o.toString(16)}`).join(',')}）`);
        }
        if (e.notOpcodes !== undefined && e.notOpcodes.some((op) => r.instructions.some((i) => i.opcode === op))) {
          problems.push(`不要な opcode が含まれる（0x${e.notOpcodes.map((o) => o.toString(16)).join(',')}）`);
        }
        if (e.notes !== undefined && !e.notes.every((n) => r.notes.some((nn) => nn.includes(n)))) {
          problems.push(`notes 欠落（期待: ${e.notes.join(' / ')}）`);
        }
      }
      if (problems.length > 0) {
        failed++;
        console.error(`  ✗ ${c.name}: ${problems.join('; ')}`);
      } else {
        console.log(`  ✓ ${c.name}`);
      }
    } catch (err) {
      if (c.expect.throwError) {
        console.log(`  ✓ ${c.name}`);
      } else {
        failed++;
        console.error(`  ✗ ${c.name}: 予期せぬ例外 — ${(err as Error).message}`);
      }
    }
  }
  return failed;
}

// ── 実行時エントリ ──
console.log('═'.repeat(60));
console.log(`  AILSM Golden Test — ${GOLDEN_CASES.length} cases`);
console.log('═'.repeat(60));
const failed = runGolden();
console.log('═'.repeat(60));
if (failed === 0) {
  console.log(`  ✅ ALL PASS — ${GOLDEN_CASES.length} golden cases`);
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
