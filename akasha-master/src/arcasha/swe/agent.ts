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
    '3. 原因の見当がついたら、すぐに write_file / edit_file で修正する（調査ばかりせず、早めに修正に着手すること）',
    '4. 修正後は run_command でテストを実行して確認する（例: python3 -m pytest で該当テストを実行）',
    '',
    '重要:',
    '- ツールは必ず正しい引数で 1 度に 1 つずつ呼び出してください',
    '- ファイルパスはリポジトリルートからの相対パスで指定してください',
    '- Python の実行には「python」ではなく「python3」を使ってください',
    '- 調査だけで終わらず、必ず write_file か edit_file で実際にコードを修正してください。修正せずに終了してはいけません',
    '- テストファイル（tests/ ディレクトリ、test_*.py、*_test.py、conftest.py）は編集・作成しないでください。テストは評価時に自動で適用されます。ソースコード（実装）のみを修正してください',
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
  let promptTokens = 0;
  let completionTokens = 0;
  let finalAnswer = '';
  let stopReason = '';
  // モデルが tool_calls なしの実際の content を返したら true（成功判定の根拠）
  let gotFinalAnswer = false;

  let emptyReplies = 0; // 不完全応答（空 content / 打ち切り）の連続回数
  for (let i = 0; i < maxIterations; i++) {
    const completion = await deps.chat(messages, tools, chatOpts);
    const { message, finishReason, usage } = completion;

    // トークン集計（usage が空の呼び出しも加算は 0 で安全）
    promptTokens += usage?.promptTokens ?? 0;
    completionTokens += usage?.completionTokens ?? 0;

    const toolResults: SweStep['toolResults'] = [];

    if (message.toolCalls.length === 0) {
      const contentOk = typeof message.content === 'string' && message.content.trim() !== '';
      // 正常な最終回答: 非空 content + finishReason 'stop'
      if (contentOk && finishReason === 'stop') {
        finalAnswer = message.content as string;
        gotFinalAnswer = true;
        stopReason = finishReason;
        steps.push({ index: i, message, toolResults, usage: usage ?? { promptTokens: 0, completionTokens: 0 }, ms: completion.ms });
        break;
      }
      // 不完全応答（空 content・'length' 打ち切り等）: 即 break せず続行を促す
      emptyReplies++;
      if (emptyReplies >= 3) {
        // 3 回連続で不完全なら諦めて終了
        finalAnswer = `（モデルが ${emptyReplies} 回連続で不完全な応答を返しました）\n最終 content: ${message.content ?? '(なし)'}`;
        gotFinalAnswer = false;
        stopReason = finishReason || 'empty_reply';
        steps.push({ index: i, message, toolResults, usage: usage ?? { promptTokens: 0, completionTokens: 0 }, ms: completion.ms });
        break;
      }
      // 不完全応答（assistant ターン）を履歴に記録してから続行を促す
      messages.push({
        role: 'assistant',
        content: message.content ?? '',
        reasoning_content: message.reasoning ?? null,
      });
      // 続行を促す user メッセージを追加して再試行
      messages.push({
        role: 'user',
        content: `（システム: 直前の応答が不完全です。まだ解決作業が終わっていません。）\n` +
          `修正が完了していない場合は、ツール（write_file / edit_file / run_command）を使って修正とテストを続けてください。\n` +
          `修正が完了したなら、変更したファイル・理由・テスト結果を日本語で詳しく書いた最終回答を返してください。`,
      });
      steps.push({ index: i, message, toolResults, usage: usage ?? { promptTokens: 0, completionTokens: 0 }, ms: completion.ms });
      continue;
    }

    // 不完全応答でなければカウンタをリセット
    emptyReplies = 0;

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

    steps.push({ index: i, message, toolResults, usage: usage ?? { promptTokens: 0, completionTokens: 0 }, ms: completion.ms });

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
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    totalMs: Date.now() - t0,
    stopReason,
  };
}
