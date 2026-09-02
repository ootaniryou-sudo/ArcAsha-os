/**
 * SWE-bench エージェント — ツールループ実装。
 *
 * フロー:
 *   1. system prompt + issue 文（problem statement）を user メッセージとして送る
 *   2. モデルが tool_calls を返したら、各ツールを実行して結果を tool メッセージとして返す
 *   3. モデルが tool_calls なしで最終回答（content）を返すまで繰り返す
 *   4. max_iterations でループを打ち切る
 *
 * 各ステップの実行・レイテンシ・ツール結果は SweAgentResult に記録する（計測可能・再現可能）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatOptions, SweAgentResult, SweContext, SweStep } from './types.js';
import type { ChatMessage } from './model.js';
import { chatCompletion, toChatTools, chatDefaults } from './model.js';
import { SWE_TOOLS, getSweTool } from './tools.js';

/** ツール名を引数へ渡すための定義（agent 用に description を補強した system を作る）。 */
const TOOL_USAGE_GUIDE = SWE_TOOLS.map((t) => {
  const args = t.parameters.map((p) => `${p.name}:${p.type}${p.description ? ` (${p.description})` : ''}`).join(', ');
  return `- ${t.name}(${args})`;
}).join('\n');

function buildSystemPrompt(): string {
  return [
    'あなたはソフトウェアエンジニアリングエージェントです。',
    '与えられたリポジトリで問題（issue）を解決してください。',
    '',
    '作業手順:',
    '1. まずリポジトリの構造を把握する（list_dir / glob_search / read_file を使う）',
    '2. 問題に関連するコードを grep_search で探し、read_file で読む',
    '3. 修正箇所を特定したら write_file / edit_file で編集する',
    '4. テストがある場合は run_command で実行して確認する（例: python -m pytest）',
    '',
    '重要:',
    '- ツールは必ず正しい引数で 1 度に 1 つずつ呼び出してください',
    '- ファイルパスはリポジトリルートからの相対パスで指定してください',
    '- 修正が完了したら、ツール呼び出しなしで最終回答（変更したファイルと理由、テスト結果）を日本語で返してください',
    '- 既存コードのスタイルを維持してください',
    '',
    '利用可能なツール:',
    TOOL_USAGE_GUIDE,
  ].join('\n');
}

export interface SweAgentOptions {
  /** 作業リポジトリのルート（絶対パス）。 */
  root: string;
  /** issue 文（problem statement）。 */
  issue: string;
  /** モデル / API オプション。省略時は env（DEEPSEEK_*）から。 */
  chat?: Partial<ChatOptions>;
  /** 最大ループ回数（既定 30）。 */
  maxIterations?: number;
  /**
   * run_command（任意コマンド実行）を許可するか。既定 false（安全のため opt-in）。
   * env ARCASHA_SWE_ALLOW_RUN=1 でも有効化される。
   */
  allowRunCommand?: boolean;
  /** 追加のコンテキスト（既存テスト名・失敗出力など）。 */
  extraContext?: string;
}

export interface SweAgentDeps {
  /** モデル呼び出し関数（テストで差し替え可能）。 */
  chat: typeof chatCompletion;
}

/** issue 文を安全に sanitize（制御文字を除去してプロンプト注入を軽減）。 */
function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
}

/**
 * エージェントを実行し、ツールループを回す。
 * 最終回答は model が tool_calls なしの content を返した時点で確定する。
 */
export async function runSweAgent(
  opts: SweAgentOptions,
  deps: SweAgentDeps = { chat: chatCompletion },
): Promise<SweAgentResult> {
  const t0 = Date.now();
  // maxIterations は正の安全な整数のみ受理（不正値は既定 30 にフォールバック）
  const rawMax = opts.maxIterations ?? 30;
  const maxIterations = Number.isSafeInteger(rawMax) && rawMax >= 1 ? rawMax : 30;
  const root = path.resolve(opts.root);
  // root の存在確認
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw new Error('root がディレクトリではありません');
  } catch (e) {
    throw new Error(`root が存在しません: ${root}（${(e as Error).message}）`);
  }

  const allowRunCommand = opts.allowRunCommand === true || process.env.ARCASHA_SWE_ALLOW_RUN === '1';
  const ctx: SweContext = { root, allowRunCommand };
  const chatOpts: ChatOptions = { ...chatDefaults(), ...opts.chat };

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: `# Issue（解決すべき問題）\n\n${sanitizeText(opts.issue)}${opts.extraContext ? `\n\n# 追加コンテキスト\n\n${sanitizeText(opts.extraContext)}` : ''}` },
  ];

  const tools = toChatTools(SWE_TOOLS);
  const steps: SweStep[] = [];
  let toolCalls = 0;
  let finalAnswer = '';
  let stopReason = '';
  // モデルが tool_calls なしの実際の content を返したら true（成功判定の根拠）
  let gotFinalAnswer = false;

  for (let i = 0; i < maxIterations; i++) {
    const completion = await deps.chat(messages, tools, chatOpts);
    const { message, finishReason } = completion;

    const toolResults: SweStep['toolResults'] = [];

    if (message.toolCalls.length === 0) {
      // モデルが最終回答を返した（content がある想定）
      finalAnswer = message.content ?? '(最終回答なし)';
      // content が実際に得られた場合のみ成功扱い（null で終わった場合は失敗）
      gotFinalAnswer = typeof message.content === 'string' && message.content.trim() !== '';
      stopReason = finishReason;
      steps.push({
        index: i,
        message,
        toolResults,
        ms: completion.ms,
      });
      break;
    }

    // tool_calls を実行する
    for (const tc of message.toolCalls) {
      toolCalls++;
      const tool = getSweTool(tc.name);
      if (!tool) {
        toolResults.push({ name: tc.name, ok: false, output: `未知のツール: ${tc.name}`, ms: 0 });
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.argumentsJson) as Record<string, unknown>;
        args = parsed;
      } catch {
        // 引数パース失敗 → 空引数で実行（ツール側で必須引数エラーになる）
      }
      const result = await tool.run(args, ctx);
      toolResults.push({ name: tc.name, ok: result.ok, output: result.output, ms: result.ms });
    }

    steps.push({ index: i, message, toolResults, ms: completion.ms });

    // assistant メッセージ（tool_calls 付き）と tool 結果を履歴へ追加
    messages.push({
      role: 'assistant',
      content: message.content,
      reasoning_content: message.reasoning,
      tool_calls: message.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argumentsJson },
      })),
    });
    for (let k = 0; k < message.toolCalls.length; k++) {
      const tc = message.toolCalls[k];
      const tr = toolResults[k];
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: tr ? (tr.ok ? tr.output : `ERROR: ${tr.output}`) : '(no result)',
      });
    }
  }

  if (finalAnswer === '') {
    // max_iterations に達した（未完了）
    finalAnswer = steps.length > 0
      ? `（最大 ${maxIterations} 回のループに達しました。最後のツール実行までで中断）\n最終メッセージ: ${steps[steps.length - 1].message.content ?? '(なし)'}`
      : '（モデルが応答しませんでした）';
    stopReason = 'max_iterations';
  }

  return {
    ok: gotFinalAnswer && finalAnswer !== '' && finalAnswer !== '(最終回答なし)',
    finalAnswer,
    steps,
    toolCalls,
    modelCalls: steps.length,
    totalMs: Date.now() - t0,
    stopReason,
  };
}
