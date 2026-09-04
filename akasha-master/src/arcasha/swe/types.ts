/**
 * SWE-bench（ソフトウェアエンジニアリングエージェント）用の型定義。
 *
 * 目的: エージェント（LLM）が「リポジトリの読解 → 検索 → 編集 → テスト実行」を
 * 繰り返せるようにするための最小 ABI を定義する。
 *
 * 設計方針:
 *   - ツールは「名前 + 説明 + パラメータ定義 + 実装」の単位（SweTool）。
 *   - 全ツールは SweContext.root（作業リポジトリ）配下のみ操作できる（安全策）。
 *   - 実行結果はテキスト文字列で返す（LLM が読むため）。構造化はしない。
 */

/** 1 つのツールのパラメータ定義（OpenAI 互換 function schema へ変換できる形）。 */
export interface SweToolParameter {
  name: string;
  /** JSON Schema 型（function calling は string へ変換される）。 */
  type: 'string' | 'integer' | 'boolean';
  description: string;
  /** enum があれば指定（任意・type に応じた値型）。 */
  enum?: Array<string | number | boolean>;
  /** 必須かどうか（true のとき OpenAI 互換 schema の required 配列へ入る）。 */
  required?: boolean;
}

/** ツール実行時のコンテキスト。root = 作業リポジトリの絶対パス。 */
export interface SweContext {
  /** 作業リポジトリのルート（絶対パス）。ツールはこの配下のみ操作できる。 */
  root: string;
  /**
   * run_command の実行可否。既定 false（安全のため opt-in）。
   * true のときのみ任意コマンドのシェル実行を許可する。
   */
  allowRunCommand?: boolean;
}

/** ツールの実行結果。 */
export interface SweToolResult {
  ok: boolean;
  /** LLM に返すテキスト（stdout / エラー / 差分など）。 */
  output: string;
  /** 実測レイテンシ（ms）。 */
  ms: number;
}

/** ツール定義（実装込み）。 */
export interface SweTool {
  name: string;
  description: string;
  parameters: SweToolParameter[];
  /** ツール本体。args はパラメータ名 → 値。context で root を渡す。 */
  run(args: Record<string, unknown>, ctx: SweContext): Promise<SweToolResult>;
}

/** エージェントが呼び出すモデルの 1 往復レスポンス（OpenAI 互換 function calling）。 */
export interface ChatToolCall {
  id: string;
  name: string;
  /** JSON 文字列の引数。 */
  argumentsJson: string;
}

export interface ChatResponseMessage {
  content: string | null;
  toolCalls: ChatToolCall[];
  /** 推論モデル（reasoning_content）があれば取得。 */
  reasoning?: string | null;
}

/** モデルの 1 往復の結果（usage 含む・実測トークン）。 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** DeepSeek 等のプロンプトキャッシュでヒットした入力トークン数（prompt_cache_hit_tokens）。 */
  cacheReadTokens?: number;
  /** キャッシュ書き込みトークン数（DeepSeek は現状報告しない）。 */
  cacheWriteTokens?: number;
}

/** ツールループの 1 ステップ結果。 */
export interface SweStep {
  index: number;
  message: ChatResponseMessage;
  /** 実行したツール名 → 結果（tool_calls がある場合）。 */
  toolResults: Array<{ name: string; ok: boolean; output: string; ms: number }>;
  /** このステップのモデル呼び出しで消費したトークン。 */
  usage: ChatUsage;
  ms: number;
}

/** エージェント全体の実行結果。 */
export interface SweAgentResult {
  ok: boolean;
  /** 最終回答（モデルの最終 content）。未完了なら最後のメッセージ。 */
  finalAnswer: string;
  /** 経過ステップ。 */
  steps: SweStep[];
  /** ツール呼び出し総数。 */
  toolCalls: number;
  /** モデル呼び出し総数（= ループ回数）。 */
  modelCalls: number;
  /** プロンプト（入力）トークン合計。 */
  promptTokens: number;
  /** 生成（出力）トークン合計。 */
  completionTokens: number;
  /** 合計トークン（prompt + completion）。 */
  totalTokens: number;
  /** 合計レイテンシ（ms）。 */
  totalMs: number;
  /** モデル停止理由（stop / tool_calls / length など）。 */
  stopReason: string;
}

/** モデル呼び出しのオプション。 */
export interface ChatOptions {
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  /** リクエストのタイムアウト（ms）。既定 120_000。 */
  timeoutMs?: number;
  /**
   * thinking モード制御（deepseek-v4 系）。'disabled' で non-thinking に切替。
   * 未指定 = モデル既定（有効）。
   */
  thinking?: 'enabled' | 'disabled';
  /**
   * thinking モードの effort 制御（deepseek-v4 系）。'low' | 'high' | 'max'。
   * thinking 有効時に reasoning の長さを調整する（low は短く・high は長く）。
   * 未指定 = モデル既定。
   */
  reasoningEffort?: 'low' | 'high' | 'max';
}
