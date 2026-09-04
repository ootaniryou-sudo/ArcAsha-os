/**
 * AILSM Normalizer — Stage 1: 同義語を正準語へ畳み込む（100% 決定論）
 *
 * 足してください / 加えて / 和を求めよ  →  ACTION_ADD
 * ファイルを検索して / grep          →  ACTION_GREP
 * 円 / 円形 / Circle                  →  circle
 *
 * 辞書で判定できない部分だけが Stage 2（LLM残差）へ委譲される。
 */

import type { Token } from './lexer.js';

export type Intent = 'solve' | 'summarize' | 'search' | 'verify' | 'code' | 'create' | 'unknown';
export type Domain = 'math' | 'code' | 'search' | 'reasoning' | 'unknown';

export type CanonicalAction =
  | 'ACTION_ADD' | 'ACTION_SUBTRACT' | 'ACTION_MULTIPLY' | 'ACTION_DIVIDE'
  | 'ACTION_SQRT' | 'ACTION_SQUARE'
  | 'ACTION_INTEGRAL' | 'ACTION_DERIVE' | 'ACTION_LIMIT' | 'ACTION_EQUATION' | 'ACTION_MATRIX'
  // ── コードファイル操作（registry v1.3.0: READ_FILE / GREP / EDIT_FILE / RUN_COMMAND） ──
  | 'ACTION_READ_FILE' | 'ACTION_GREP' | 'ACTION_EDIT_FILE' | 'ACTION_RUN_COMMAND'
  // ── Git / テスト / 編集細分化 / ファイル操作 / 検索強化（registry v1.4.0） ──
  | 'ACTION_GIT_DIFF' | 'ACTION_GIT_STATUS' | 'ACTION_RUN_TESTS' | 'ACTION_REPLACE_ALL'
  | 'ACTION_INSERT_LINE' | 'ACTION_APPEND_LINE' | 'ACTION_MOVE_FILE' | 'ACTION_DELETE_FILE'
  | 'ACTION_GREP_CONTEXT' | 'ACTION_FIND_SYMBOL';

/** コードファイル操作アクション（ドメインを code へ導くシグナル） */
export const CODE_ACTIONS: readonly CanonicalAction[] = [
  'ACTION_READ_FILE',
  'ACTION_GREP',
  'ACTION_EDIT_FILE',
  'ACTION_RUN_COMMAND',
  'ACTION_GIT_DIFF',
  'ACTION_GIT_STATUS',
  'ACTION_RUN_TESTS',
  'ACTION_REPLACE_ALL',
  'ACTION_INSERT_LINE',
  'ACTION_APPEND_LINE',
  'ACTION_MOVE_FILE',
  'ACTION_DELETE_FILE',
  'ACTION_GREP_CONTEXT',
  'ACTION_FIND_SYMBOL',
];

export const CODE_ACTION_SET: ReadonlySet<CanonicalAction> = new Set(CODE_ACTIONS);

export interface NormalizedInput {
  intent: Intent;
  domain: Domain;
  actions: CanonicalAction[];
  objects: string[];
  attributes: { name: string; value: string }[];
  numbers: number[];
  variables: string[];
  rawMath: string[];
  output: string | null;
  inputText: string;
  confidence: number; // 0..1
}

export const ACTION_SYNONYMS: Record<CanonicalAction, readonly string[]> = {
  ACTION_ADD: ['足し算', '足す', '足して', '足してください', '加える', '加えて', 'たす', 'たし算', '加算', '合計', '和を求める', '和を求めよ'],
  ACTION_SUBTRACT: ['引き算', '引く', '引いて', '減算', '差を求める', '減らす'],
  ACTION_MULTIPLY: ['掛け算', '掛ける', '掛けて', 'かける', 'かけて', '乗算', '積を求める'],
  ACTION_DIVIDE: ['割り算', '割って', '割り', '割る', '除算', '商を求める'],
  ACTION_SQRT: ['平方根', 'ルート', '√'],
  ACTION_SQUARE: ['二乗', '平方'],
  ACTION_INTEGRAL: ['積分', 'インテグラル'],
  ACTION_DERIVE: ['微分', 'デリバティブ', '導関数'],
  ACTION_LIMIT: ['極限', 'リミット'],
  ACTION_EQUATION: ['方程式', '等式'],
  ACTION_MATRIX: ['行列', 'マトリックス'],
  // ── コードファイル操作（SWE）。汎用の「を読んで / を修正して」等は
  //    ファイル・コード文脈（ファイル/ソース/コード語、パス、拡張子）がある場合のみ
  //    下の hasFileContext ゲートを通して採用する（数学等の誤誘導を防ぐ）。 ──
  ACTION_READ_FILE: ['ファイルを読んで', 'ファイルを読む', 'ファイルを読み', 'ソースを読んで', 'コードを読んで', '読み込んで', 'read file', 'read the file'],
  ACTION_GREP: ['ファイルを検索', 'ファイルを探', 'ソースを検索', 'ソースを探', 'コードを検索', 'コードを探', '関数を検索', '関数を探', 'クラスを検索', 'クラスを探', 'シンボルを検索', 'grep', 'をgrep'],
  ACTION_EDIT_FILE: ['ファイルを修正', 'ファイルを編集', 'ファイルを直', 'ソースを修正', 'ソースを編集', 'コードを修正', 'コードを編集', 'コードを直', 'バグを修正', 'バグを直', 'edit file', 'fix the bug'],
  // 汎用のコマンド実行。テスト・ビルドは専用命令（RUN_TESTS）へ分離したので、
  // 「テストを実行」は ACTION_RUN_COMMAND ではなく ACTION_RUN_TESTS に分類される。
  ACTION_RUN_COMMAND: ['コマンドを実行', 'コマンド実行', 'コマンドを走ら', 'ビルドを実行', 'ビルドを走ら', 'シェルで実行', 'シェルを実行', 'run command', 'run the command'],
  // ── v1.4.0: Git / テスト / 編集細分化 / ファイル操作 / 検索強化 ──
  ACTION_GIT_DIFF: ['差分を確認', '差分を表示', '差分を見る', '変更差分', 'diffを確認', '差分をチェック', 'git diff', 'git-diff'],
  // Git 固有の語句のみ（「状態を確認して」等の一般語は誤分類を招くので含めない）
  ACTION_GIT_STATUS: ['変更状態', '作業ツリーの状態', 'リポジトリの状態', 'git status', 'git-status', '変更状況'],
  ACTION_RUN_TESTS: ['テストを実行', 'テストを走ら', 'テストを流', 'テストを回', 'テストを動か', 'テストを試', 'テストをかけ', 'run tests', 'run the tests', 'run test', 'pytest', 'ユニットテスト', 'ユニットテストを実行'],
  ACTION_REPLACE_ALL: ['全置換', '全部置換', '一括置換', 'すべて置換', '全一致を置換', '全箇所を置換', 'replace all', 'replace-all'],
  ACTION_INSERT_LINE: ['行を挿入', '行に挿入', '指定行に挿入', '指定行に追加', '行を追加', 'insert line', 'insert-line'],
  ACTION_APPEND_LINE: ['末尾に追加', '末尾に追記', '最後に追記', '最後に追加', 'ファイル末尾に', 'append line', 'append-line'],
  ACTION_MOVE_FILE: ['ファイルを移動', 'ファイル移動', 'ファイルをリネーム', 'ファイルを改名', 'ファイルを移し', 'move file', 'rename file'],
  ACTION_DELETE_FILE: ['ファイルを削除', 'ファイル削除', 'ファイルを消し', 'ファイルを除去', 'ファイルを消去', 'delete file', 'remove file'],
  ACTION_GREP_CONTEXT: ['前後行付きで検索', '文脈付きで検索', 'コンテキスト付きで検索', '前後を添えて検索', '周辺行ごと検索', 'grep -C', 'grep -A', 'grep -B'],
  ACTION_FIND_SYMBOL: ['定義を検索', '定義を探', '定義位置', '関数の定義を探', 'クラスの定義を探', 'メソッドの定義を探', '定義を調べ', 'find symbol', 'find-symbol', 'シンボルの定義'],
};

/**
 * ファイル・コード文脈がある語（これらが無いと「を読んで」「を修正して」等の
 * 汎用語を code アクションとして採用しない）。ファイルパス（/ や拡張子）も文脈として扱う。
 */
const FILE_CONTEXT_WORDS = [
  'ファイル', 'ソース', 'コード', 'スクリプト', '関数', 'クラス', 'メソッド', 'バグ',
  'テスト', 'ビルド', 'リポジトリ', 'プロジェクト', 'モジュール', 'ファイル名',
];

/**
 * 汎用の読み/修正語。ファイル・コード文脈がある場合のみ code アクションとして扱う。
 * 例: 「問題を読んで解いて」→ 文脈なし → 数学解釈へ委ねる（READ_FILE にしない）
 *     「src/main.ts を読んで」→ パス文脈あり → READ_FILE
 */
const CONTEXT_DEPENDENT_READ_WORDS = ['を読んで', 'を読む', 'を読み', '読んで', '読み込んで'];
const CONTEXT_DEPENDENT_EDIT_WORDS = ['を修正して', 'を編集して', 'を書き換えて', '修正して', '編集して', '書き換えて'];

/** 文にファイル・コード文脈（語彙 or パス or 拡張子）があるか判定する。 */
function hasFileContext(t: string): boolean {
  if (FILE_CONTEXT_WORDS.some((w) => t.includes(w))) return true;
  // パス（ディレクトリ名 + / + basename）または拡張子（.py .ts .js .rs 等）
  if (/\S+\/\S+/.test(t)) return true;
  if (/\.(py|ts|js|tsx|jsx|rs|go|java|rb|c|h|cpp|hpp|cs|kt|swift|sh|json|yaml|yml|toml|md)\b/i.test(t)) return true;
  return false;
}

const INTENT_WORDS: { intent: Intent; words: readonly string[] }[] = [
  { intent: 'solve', words: ['解いて', '解け', '求めよ', '求めて', '計算して', '計算', '積分', '微分', '極限', '方程式', 'solve', 'calculate'] },
  { intent: 'summarize', words: ['要約', 'まとめて', '要旨', 'summarize'] },
  { intent: 'search', words: ['検索', '探して', '調べて', 'search'] },
  { intent: 'verify', words: ['検証', '確認して', 'verify'] },
  { intent: 'code', words: ['コード', 'プログラム', '関数を書いて', 'バグ修正', '修正して'] },
  { intent: 'create', words: ['作って', '作る', '作成', '実装', '書いて', '生成', '開発', '作りたい', '作ろう', '作ります', '作成して', '実装して', 'build', 'make', 'create', 'implement', 'generate', 'write'] },
];

const OBJECT_SYNONYMS: Record<string, readonly string[]> = {
  circle: ['円形', '円', 'サークル'],
  square: ['正方形', '四角形'],
  triangle: ['三角形', '三角'],
  matrix: ['行列'],
  function: ['関数', 'ファンクション'],
};

const ATTRIBUTE_SYNONYMS: Record<string, readonly string[]> = {
  radius: ['半径'],
  diameter: ['直径'],
  area: ['面積'],
  perimeter: ['周囲', '周長', '外周'],
  side: ['一辺', '辺'],
};

const OUTPUT_SYNONYMS: Record<string, readonly string[]> = {
  area: ['面積'],
  perimeter: ['周囲', '周長', '外周'],
};

export function normalize(text: string, tokens: Token[]): NormalizedInput {
  const t = text.trim();

  let intent: Intent = 'unknown';
  for (const p of INTENT_WORDS) {
    if (p.words.some((w) => t.includes(w))) {
      intent = p.intent;
      break;
    }
  }

  const actions: CanonicalAction[] = [];
  for (const [action, words] of Object.entries(ACTION_SYNONYMS) as [CanonicalAction, readonly string[]][]) {
    if (words.some((w) => t.includes(w))) actions.push(action);
  }
  // 汎用の読み/修正語（「を読んで」「を修正して」等）は、ファイル・コード文脈が
  // ある場合のみ code アクションとして追加する（数学等の誤誘導を防ぐ）。
  // 例: 「問題を読んで解いて」→ 文脈なし → READ_FILE にしない
  //     「src/main.ts を読んで」→ パス文脈あり → READ_FILE を追加
  const fileCtx = hasFileContext(t);
  if (fileCtx) {
    if (CONTEXT_DEPENDENT_READ_WORDS.some((w) => t.includes(w)) && !actions.includes('ACTION_READ_FILE')) {
      actions.push('ACTION_READ_FILE');
    }
    if (CONTEXT_DEPENDENT_EDIT_WORDS.some((w) => t.includes(w)) && !actions.includes('ACTION_EDIT_FILE')) {
      actions.push('ACTION_EDIT_FILE');
    }
  }
  // コードファイル操作アクションが決まったのに intent が unknown のままなら、
  // ファイル/コードを対象にしているので intent を code に補完する（semantic の
  // 「解釈不能」判定を回避）。「src/main.ts を読んで」などが該当。
  if (intent === 'unknown' && actions.some((a) => CODE_ACTION_SET.has(a))) {
    intent = 'code';
  }

  const objects: string[] = [];
  for (const [obj, words] of Object.entries(OBJECT_SYNONYMS)) {
    if (words.some((w) => t.includes(w))) objects.push(obj);
  }

  const attributes: { name: string; value: string }[] = [];
  for (const [name, words] of Object.entries(ATTRIBUTE_SYNONYMS)) {
    let pos = -1;
    let matched = '';
    for (const w of words) {
      const idx = t.indexOf(w);
      if (idx >= 0 && idx > pos) {
        pos = idx;
        matched = w;
      }
    }
    if (pos >= 0) {
      const m = /^\s*(\d+(?:\.\d+)?)/.exec(t.slice(pos + matched.length));
      attributes.push({ name, value: m ? m[1] : '' });
    }
  }

  const numbers = tokens.filter((tk) => tk.type === 'number').map((tk) => Number(tk.value));
  const variables = [...new Set(tokens.filter((tk) => tk.type === 'variable').map((tk) => tk.value))];
  const rawMath = tokens.filter((tk) => tk.type === 'math').map((tk) => tk.value);

  let output: string | null = null;
  for (const [outName, words] of Object.entries(OUTPUT_SYNONYMS)) {
    if (words.some((w) => t.includes(w))) {
      output = outName;
      break;
    }
  }

  let domain: Domain = 'unknown';
  const hasCodeAction = actions.some((a) => CODE_ACTION_SET.has(a));
  const mathSignals = rawMath.length > 0 || actions.some((a) => a.startsWith('ACTION_') && !CODE_ACTION_SET.has(a));
  // 数式・数学アクションが明示的な場合は math を最優先（generator が math opcode を
  // 出力するため、verify/summarize 意図でも domain=reasoning に倒すと Capability 検証が矛盾する）。
  if (mathSignals) {
    domain = 'math';
  } else if (intent === 'summarize') {
    // 要約が目的の文は、読みの語を含んでいても reasoning を優先（読解が主目的）
    domain = 'reasoning';
  } else if (hasCodeAction) {
    // コードファイル操作（読む/検索/編集/実行/Git/テスト/ファイル操作）は code ドメイン。
    // 「差分を確認して」「テストを実行して」等の検証系も、明示的な code 操作語があれば
    // コード検証として code へ倒す（汎用の「結果を検証して」は code アクションが無いので reasoning のまま）。
    domain = 'code';
  } else {
    if (actions.length > 0 || intent === 'solve' || objects.some((o) => o !== 'function')) {
      domain = 'math';
    }
    if (intent === 'code' || intent === 'create') domain = 'code';
    if (intent === 'search') domain = 'search';
    if (intent === 'verify') domain = 'reasoning';
  }

  const signals =
    (intent !== 'unknown' ? 1 : 0) +
    actions.length +
    objects.length +
    attributes.length +
    rawMath.length +
    (numbers.length > 0 ? 1 : 0);
  const confidence = Math.min(1, signals / 3);

  return {
    intent,
    domain,
    actions,
    objects,
    attributes,
    numbers,
    variables,
    rawMath,
    output,
    inputText: t,
    confidence,
  };
}
