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
  | 'ACTION_READ_FILE' | 'ACTION_GREP' | 'ACTION_EDIT_FILE' | 'ACTION_RUN_COMMAND';

/** コードファイル操作アクション（ドメインを code へ導くシグナル） */
export const CODE_ACTIONS: readonly CanonicalAction[] = [
  'ACTION_READ_FILE',
  'ACTION_GREP',
  'ACTION_EDIT_FILE',
  'ACTION_RUN_COMMAND',
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
  // ── コードファイル操作（SWE） ──
  ACTION_READ_FILE: ['ファイルを読んで', 'ファイルを読む', 'ファイルを読み', 'ソースを読んで', 'コードを読んで', 'を読んで', 'を読む', '読み込んで', 'read file', 'read the file'],
  ACTION_GREP: ['ファイルを検索', 'ファイルを探', 'ソースを検索', 'ソースを探', 'コードを検索', 'コードを探', '関数を検索', '関数を探', 'クラスを検索', 'クラスを探', 'シンボルを検索', 'grep', 'をgrep'],
  ACTION_EDIT_FILE: ['ファイルを修正', 'ファイルを編集', 'ファイルを直', 'ソースを修正', 'ソースを編集', 'コードを修正', 'コードを編集', 'コードを直', 'バグを修正', 'バグを直', 'を修正して', 'を編集して', 'を書き換えて', '書き換えて', 'edit file', 'fix the bug'],
  ACTION_RUN_COMMAND: ['コマンドを実行', 'コマンド実行', 'コマンドを走ら', 'テストを実行', 'テストを走ら', 'ビルドを実行', 'ビルドを走ら', 'シェルで実行', 'シェルを実行', 'run command', 'run the command'],
};

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
  if (intent === 'summarize' || intent === 'verify') {
    // 要約・検証が目的の文は、読み/検索の語を含んでいても reasoning を優先
    domain = 'reasoning';
  } else if (hasCodeAction) {
    // コードファイル操作（読む/検索/編集/実行）は code ドメイン
    domain = 'code';
  } else {
    if (actions.length > 0 || rawMath.length > 0 || intent === 'solve' || objects.some((o) => o !== 'function')) {
      domain = 'math';
    }
    if (intent === 'code' || intent === 'create') domain = 'code';
    if (intent === 'search') domain = 'search';
    // （summarize / verify は上の分岐で処理済み — reasoning 優先）
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
