/**
 * SWE-bench エージェント用のモデルクライアント（OpenAI 互換 function calling）。
 *
 * 既存の ExpertHub（apiGenerate）は単発テキスト補完のみで function calling に
 * 対応していないため、ここに tools 対応の /v1/chat/completions 呼び出しを実装する。
 *
 * 送受信するメッセージ型（OpenAI 互換）:
 *   - system / user / assistant（tool_calls 含む可）/ tool（tool_call_id 付き）
 * 返却:
 *   - content / tool_calls / reasoning（推論モデル用）
 */
import type { ChatOptions, ChatResponseMessage, ChatToolCall, ChatUsage } from './types.js';

/** 会話メッセージ（OpenAI 互換）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant の tool_calls（関数呼び出し要求）。 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** tool メッセージの対応 tool_call_id。 */
  tool_call_id?: string;
  /** 推論モデルの thinking（送信時は不要だが、履歴保持に使う）。 */
  reasoning_content?: string | null;
}

/** 関数定義（OpenAI 互換 tools 配列の 1 要素）。 */
export interface ChatToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/** 1 回の chat 呼び出しの結果。 */
export interface ChatCompletionResult {
  message: ChatResponseMessage;
  usage: ChatUsage;
  /** 停止理由（stop / tool_calls / length）。 */
  finishReason: string;
  /** 実測レイテンシ（ms）。 */
  ms: number;
  /** 生レスポンス（デバッグ用）。 */
  raw: string;
}

/** 既定の DeepSeek エンドポイント・モデル（env で上書き可）。 */
export function chatDefaults(): ChatOptions {
  return {
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    baseUrl: (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    maxTokens: 2048,
    temperature: 0,
    timeoutMs: 120_000,
  };
}

/**
 * OpenAI 互換 /v1/chat/completions を tools 付きで 1 回呼ぶ。
 * tool_choice=auto でモデルに任せる。
 */
export async function chatCompletion(
  messages: ChatMessage[],
  tools: ChatToolDef[],
  opts: ChatOptions,
): Promise<ChatCompletionResult> {
  if (!opts.apiKey) throw new Error('DEEPSEEK_API_KEY が設定されていません（.env を確認）');
  const t0 = Date.now();

  // baseUrl の末尾 /v1 を正規化して二重パスを防ぐ（例: .../v1 → .../v1/chat/completions）
  const base = opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const endpoint = `${base}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // thinking モード制御（deepseek-v4 系は既定で有効のため、素のモデル比較では
  // 'disabled' を指定して reasoning が出力トークンを消費し尽くすのを防ぐ）
  if (opts.thinking) {
    body.thinking = { type: opts.thinking };
  }
  // thinking effort 制御（reasoning の長さを調整）
  if (opts.reasoningEffort) {
    body.reasoning_effort = opts.reasoningEffort;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status} (${opts.model}): ${text.slice(0, 300)}`);
  }
  const raw = await res.text();
  const data = JSON.parse(raw) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const msg = data.choices?.[0]?.message;
  const finishReason = data.choices?.[0]?.finish_reason ?? '';
  if (!msg) throw new Error('API returned no choices');

  const toolCalls: ChatToolCall[] = (msg.tool_calls ?? [])
    .filter((tc) => tc.function?.name)
    .map((tc) => ({
      id: tc.id ?? `call_${Date.now()}`,
      name: tc.function!.name!,
      argumentsJson: tc.function!.arguments ?? '{}',
    }));

  const message: ChatResponseMessage = {
    content: typeof msg.content === 'string' && msg.content !== '' ? msg.content : null,
    toolCalls,
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : null,
  };

  return {
    message,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
    finishReason,
    ms: Date.now() - t0,
    raw,
  };
}

/**
 * SweTool 定義を OpenAI 互換 tools 配列へ変換する。
 * parameters のうち required=true のものを schema の required 配列へ入れる。
 */
export function toChatTools(tools: Array<{
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; description: string; enum?: Array<string | number | boolean>; required?: boolean }>;
}>): ChatToolDef[] {
  return tools.map((t) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of t.parameters) {
      const prop: Record<string, unknown> = { type: p.type, description: p.description };
      if (p.enum) prop.enum = p.enum;
      properties[p.name] = prop;
      if (p.required === true) required.push(p.name);
    }
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties, required },
      },
    };
  });
}
