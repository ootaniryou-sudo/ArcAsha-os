/**
 * AILSM Guide — LLM が AILSM を「読める・書ける」ための説明書
 *
 * AILSM（ArcAsha Inter Language for Small AI models）は ArcAsha の中心にある
 * 型付き中間言語（IR）で、registry.json（唯一の権威）が全 85 命令を定義する。
 * このモジュールは、その registry から LLM 向けの「説明書」を自動生成する。
 *
 * LLM は人間向けの仕様書を読まなくても、このガイドだけで
 *   - 自然言語 → AILSM 命令列 の書き方を理解できる
 *   - 自分が書いた AILSM を ailsm_compile ツールで検証できる
 * ことを目指す。
 *
 * 設計:
 *   - buildAilsmGuide()      … 全命令をカテゴリ別に自然言語で説明（長文・辞典用）
 *   - buildAilsmQuickGuide() … エージェントの system prompt に埋め込む要約版（短い）
 * どちらも registry から生成するので、registry を更新すればガイドも追従する。
 */
import { loadRegistry } from '../ailsa/vocab.js';

/** カテゴリ → 人間向けの説明（LLM が読む） */
const CATEGORY_NOTE: Record<string, string> = {
  task: 'タスク宣言（この仕事は何か）。文の先頭で TASK_* を宣言し、SLOT_GOAL 等で目的を添える',
  domain: 'ドメイン宣言（どの専門分野か）。CALL の前に DOMAIN_* を置くことが多い',
  slot: 'スロット（値を持つフィールド）。命令の直後に置き、SLOT_GOAL="…" のように値を与える',
  control: '制御命令（実行フロー）。CALL / RETURN / STORE / LOAD / 並列・統合など。RETURN で 1 命令列が終わる。v1.3.0 以降は拡張制御（分散 NODE_SEND〜 / 教訓 LESSON_STORE〜 / 観測 TRACE_POINT / 検証 ASSERT）も含む',
  math: '数学方言（Math Dialect）: 方程式・微分・積分・四則などの数学演算',
  code: 'コード方言（Code Dialect）: 関数・クラス・パッチ・ビルド・テスト、および SWE オペレーション（検索・読み書き・コマンド実行）',
  search: '検索方言（Search Dialect）: 問い合わせ・抽出',
  reasoning: '推論方言（Reasoning Dialect）: 因果・目標',
  syscall: 'システムコール: AI OS の機能（実行・生成・計画・検証・記憶操作・ルーティング）を呼ぶ',
};

/** 命令名の日本語ラベル（LLM 向けの簡潔な意味） */
const NAME_LABEL: Record<string, string> = {
  CALL: 'エキスパートを呼ぶ（例: CALL [SLOT_EXPERT="math"][SLOT_TASK_ID="0"]）',
  RETURN: '結果を返して命令列を終える',
  STORE: '記憶へ保存',
  LOAD: '記憶から読み出す',
  FAIL: '失敗を通知して終了',
  SUCCESS: '成功を通知して終了',
  PLAN: '実行計画を生成',
  VERIFY: '検証する',
  DECOMPOSE: 'タスクを小さな部分に分解',
  DEPENDENCY: '部分タスク間の依存関係を宣言',
  PARALLEL: '並列実行を宣言',
  MERGE: '複数の結果を統合',
  SEARCH: '検索を実行',
  RANK: '候補を順位付け',
  FILTER: '候補を絞り込む',
  EQ: '方程式を解く',
  DERIVE: '微分する',
  LIMIT: '極限を求める',
  MATRIX: '行列演算',
  INTEGRAL: '積分する',
  ADD: '加算', SUBTRACT: '減算', MULTIPLY: '乗算', DIVIDE: '除算', SQRT: '平方根', SQUARE: '二乗',
  FUNCTION: '関数を定義・生成', CLASS: 'クラスを定義・生成', PATCH: 'コードにパッチを当てる',
  BUILD: 'ビルドする', TEST: 'テストを実行する',
  QUERY: '問い合わせる', EXTRACT: '結果から情報を抽出する',
  CAUSE: '因果関係を分析する', GOAL: '目標を宣言する',
  // v1.3.0: SWE オペレーション（code 方言）
  GREP: 'コードを検索する（例: GREP [SLOT_INPUT="TODO"]）',
  READ_FILE: 'ファイルを読む（例: READ_FILE [SLOT_INPUT="src/main.ts"]）',
  EDIT_FILE: 'ファイルを編集する（例: EDIT_FILE [SLOT_INPUT="TODO を FIXME に置換"]）',
  RUN_COMMAND: 'コマンドを実行する（例: RUN_COMMAND [SLOT_INPUT="npm run build"]）',
  // v1.3.0: 拡張制御（base）
  NODE_SEND: '分散: ノードへメッセージ送信',
  NODE_RECV: '分散: ノードからメッセージ受信',
  BARRIER: '分散: 全ノードの同期バリア',
  REDUCE: '分散: 部分結果の集約',
  LESSON_STORE: '教訓（失敗からの学び）を保存',
  LESSON_RETRIEVE: '教訓を想起して適用',
  TRACE_POINT: '観測点を埋める（トレース）',
  ASSERT: '実行時検証（不変条件の確認）',
};

/** カテゴリ表示順 */
const CATEGORY_ORDER = ['task', 'domain', 'slot', 'control', 'math', 'code', 'search', 'reasoning', 'syscall'];

function fmtOpcode(n: number): string {
  return `0x${n.toString(16).padStart(2, '0').toUpperCase()} (${n})`;
}

/** 全命令の自然言語ガイド（LLM が読める長文版） */
export function buildAilsmGuide(): string {
  const reg = loadRegistry();
  const lines: string[] = [];
  lines.push(`# AILSM 指示語ガイド（registry v${reg.version}）`);
  lines.push('');
  lines.push('AILSM は「小さな AI が理解できる型付き命令語」です。');
  lines.push('1 つの指示は「命令オペコード + スロット（名前=値）」の並びで表します。');
  lines.push('例: CALL [SLOT_EXPERT="math"][SLOT_TASK_ID="0"] は「math エキスパートにタスク 0 を任せる」です。');
  lines.push('');
  for (const cat of CATEGORY_ORDER) {
    const entries = reg.instructions.filter((e) => e.category === cat);
    if (entries.length === 0) continue;
    lines.push(`## ${cat.toUpperCase()} — ${CATEGORY_NOTE[cat] ?? ''}`);
    lines.push('');
    for (const e of entries) {
      const label = NAME_LABEL[e.name] ?? e.description ?? '';
      lines.push(`- \`${e.name}\` ${fmtOpcode(e.opcode)}: ${label}`);
    }
    lines.push('');
  }
  lines.push('## 書き方の例（自然言語 → AILSM）');
  lines.push('');
  lines.push('1. 「x+2=5 を解いて」');
  lines.push('   → TASK_SOLVE [SLOT_GOAL="solve"] / DOMAIN_MATH / EQ [SLOT_INPUT="x+2=5"] / RETURN [SLOT_TASK_ID="0"]');
  lines.push('2. 「この文章を要約して」');
  lines.push('   → TASK_SUMMARIZE [SLOT_INPUT="…"] / CALL [SLOT_EXPERT="reasoning"] / RETURN');
  lines.push('3. 「バグを修正して」');
  lines.push('   → TASK_PATCH [SLOT_GOAL="fix"] / DOMAIN_CODE / PATCH [SLOT_INPUT="…"] / TEST / RETURN');
  lines.push('4. 「src/main.ts のバグを修正して」（SWE）');
  lines.push('   → CALL [SLOT_EXPERT="programming"] / DOMAIN_CODE / EDIT_FILE [SLOT_INPUT="src/main.ts のバグを修正して"] / TASK_PATCH / RETURN');
  lines.push('5. 「コードを検索して」（SWE）');
  lines.push('   → CALL [SLOT_EXPERT="programming"] / DOMAIN_CODE / GREP [SLOT_INPUT="コードを検索して"] / TASK_SEARCH / RETURN');
  lines.push('');
  lines.push('注意:');
  lines.push('- 命令列は RETURN（または SUCCESS/FAIL）で終わります');
  lines.push('- スロットは命令の直後に置き、[SLOT_名前="値"] の形で書きます');
  lines.push('- 検証は ailsm_compile ツールで行えます（自然言語を渡すと命令列を返します）');
  return lines.join('\n');
}

/** system prompt 埋め込み用の要約版（短く・最重要だけ） */
export function buildAilsmQuickGuide(): string {
  const lines: string[] = [];
  lines.push('【AILSM 要約ガイド】ArcAsha の型付き命令語（IR）。指示は「命令 + [スロット="値"]」の並び:');
  lines.push('- タスク宣言: TASK_SOLVE（解く）/ TASK_VERIFY（検証）/ TASK_PATCH（修正）/ TASK_SUMMARIZE（要約）/ TASK_SEARCH（検索）');
  lines.push('- 制御: CALL（エキスパート呼出）/ RETURN（終了）/ STORE・LOAD（記憶）/ DECOMPOSE（分解）/ VERIFY（検証）');
  lines.push('- コード操作（SWE）: GREP（検索）/ READ_FILE（読取）/ EDIT_FILE（編集）/ RUN_COMMAND（コマンド実行）');
  lines.push('- スロット: SLOT_GOAL（目的）/ SLOT_INPUT（入力）/ SLOT_EXPERT（担当）/ SLOT_TASK_ID（ID）');
  lines.push(`- 例: 「x+2=5 を解く」→ TASK_SOLVE [SLOT_GOAL="solve"] / DOMAIN_MATH / EQ [SLOT_INPUT="x+2=5"] / RETURN`);
  lines.push('- 自然言語を AILSM に変換・検証したいときは ailsm_compile ツールを呼ぶこと（書いた命令列が正しいか確認できる）');
  return lines.join('\n');
}
