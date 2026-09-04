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
import { buildAilsmQuickGuide } from './ailsm-guide.js';
import { createAuditLogger, sha256 } from './audit.js';
import type { AuditLogger } from './audit.js';
import { cacheHitRate } from './cache-stats.js';
import { ensureBranch, commitAll, pushAndDiff, branchName, isGitRepo } from './pr-workflow.js';

/** ツール名を引数へ渡すための定義（agent 用に description を補強した system を作る）。 */
const TOOL_USAGE_GUIDE = SWE_TOOLS.map((t) => {
  const args = t.parameters.map((p) => `${p.name}:${p.type}${p.description ? ` (${p.description})` : ''}`).join(', ');
  return `- ${t.name}(${args})`;
}).join('\n');

function buildSystemPrompt(opts: { safeMode?: boolean } = {}): string {
  const safeMode = opts.safeMode ?? false;
  return [
    'あなたはソフトウェアエンジニアリングエージェントです。',
    '与えられたリポジトリで問題（issue）を解決してください。',
    '',
    '【タスクの種類を見極めること】',
    '- 修正が必要なタスク: バグ修正・機能追加・リファクタリング等 → 調査して実際にコードを修正する',
    '- 修正が不要なタスク: 質問・調査報告・説明・読むだけの依頼 → ツールで必要最小限を確認したら、すぐに最終回答を返す（ファイルは変更しない）',
    '',
    '作業手順:',
    '1. まずリポジトリの構造を把握する（list_dir / glob_search / read_file を使う）',
    '2. 問題に関連するコードを grep_search / grep_context / find_symbol で探し、read_file で読む',
    '3. 原因の見当がついたら、すぐに write_file / edit_file / replace_all / insert_line / append_line で修正する（調査ばかりせず、早めに修正に着手すること）',
    '4. 修正後は run_tests（pytest）で該当テストを実行して確認する。編集前後の差分は git_diff / git_status で確認でき、誤った変更は git_revert で取り消せる',
    ...(safeMode
      ? [
          '',
          '【安全モード（実ワークスペース）】あなたの編集は自動で専用ブランチに隔離されます。',
          '- 編集は通常どおり write_file / edit_file で行ってください。',
          '- ループ終了時に、あなたの変更は作業ブランチへ commit され、可能なら push されます。',
          '- main などの共有ブランチへ直接マージしないでください。人間のレビューと CI の承認を待ってからマージされます。',
        ]
      : []),
    '',
    '重要（ツールループの収束ルール）:',
    '- ツールは必ず正しい引数で 1 度に 1 つずつ呼び出してください',
    '- 同じツールを同じ引数で繰り返し呼ばないでください（結果は同じです。前に進めないなら結論を出してください）',
    '- 調査（list_dir / read_file / grep_search / grep_context / glob_search / find_symbol / git_status / git_diff）は合計 10 回までにしてください。それ以上調べても結論が変わらないなら、わかった範囲で最終回答してください',
    '- ファイルパスはリポジトリルートからの相対パスで指定してください',
    '- Python の実行には「python」ではなく「python3」を使ってください',
    '- 修正が必要なタスクでは、write_file / edit_file / replace_all / insert_line 等で実際にコードを修正してください',
    '- テストファイル（tests/ ディレクトリ、test_*.py、*_test.py、conftest.py）は編集・作成・削除しないでください。テストは評価時に自動で適用されます。ソースコード（実装）のみを修正してください',
    '- 修正が完了したら、ツール呼び出しなしで最終回答（変更したファイルと理由、テスト結果）を日本語で返してください',
    '- 既存コードのスタイルを維持してください',
    '',
    '利用可能なツール:',
    TOOL_USAGE_GUIDE,
    '',
    buildAilsmQuickGuide(),
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
   * honorEnvAllowRun=true（既定）のときは env ARCASHA_SWE_ALLOW_RUN=1 でも有効化される。
   * サーバ経由では honorEnvAllowRun=false にして env を無視する（CLI 専用）。
   */
  allowRunCommand?: boolean;
  /**
   * env ARCASHA_SWE_ALLOW_RUN を尊重するか。既定 true（CLI 互換）。
   * サーバ（/api/agent）では false を指定する。
   */
  honorEnvAllowRun?: boolean;
  /**
   * 安全モード（実ワークスペース編集をブランチ + commit + PR に載せる）。
   * true のとき、エージェントが write/edit 系ツールで変更した内容を、
   * ループ終了時に作業ブランチへ commit し（可能なら push）する。
   * SWE-bench 評価（一時サンドボックス）では false のまま直接編集する。
   */
  safeMode?: boolean;
  /**
   * 監査ロガー。省略時は既定（~/.arcasha/agent-audit/ へ append-only + HMAC）。
   * テストでメモリ内ロガーに差し替え可能。
   */
  audit?: AuditLogger;
  /** 中断信号（SSE クライアント切断時など）。ループ先頭と各ツール実行前に確認する。 */
  signal?: AbortSignal;
  /** 追加のコンテキスト（既存テスト名・失敗出力など）。 */
  extraContext?: string;
  /**
   * 各ステップ完了時の進捗コールバック（SSE ストリーミング等で使う）。
   * ループの各反復後、そのステップ（ツール結果含む）を渡す。
   */
  onStep?: (step: SweStep, index: number) => void;
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

  const allowRunCommand = opts.allowRunCommand === true || (opts.honorEnvAllowRun !== false && process.env.ARCASHA_SWE_ALLOW_RUN === '1');
  const ctx: SweContext = { root, allowRunCommand };
  const chatOpts: ChatOptions = { ...chatDefaults(), ...opts.chat };

  // 監査ログ（全ツール呼び出し・モデル応答の署名付き証跡）。省略時は既定ロガー。
  const audit = opts.audit ?? createAuditLogger();
  const agentRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await audit.emit({ kind: 'agent', agentRunId, name: 'start', args: { root, safeMode: !!opts.safeMode, issue: sanitizeText(opts.issue).slice(0, 200) } });

  // 安全モード: 実ワークスペース編集をブランチへ隔離する（SWE-bench 評価は false のまま）。
  // ループ前に作業ブランチを確保し、ループ終了時に commit + push する。
  let safeBranch: string | null = null;
  if (opts.safeMode) {
    const gitOk = await isGitRepo(root);
    if (gitOk) {
      safeBranch = branchName();
      const br = await ensureBranch(root, safeBranch);
      await audit.emit({ kind: 'system', agentRunId, name: 'branch', meta: { message: br.message } });
    } else {
      await audit.emit({ kind: 'system', agentRunId, name: 'branch', meta: { message: 'git リポジトリでないため safe-mode をスキップ（直接編集）' } });
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ safeMode: opts.safeMode }) },
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
    // クライアント切断などの中断信号があれば即座に打ち切る
    if (opts.signal?.aborted) {
      stopReason = 'aborted';
      finalAnswer = steps.length > 0
        ? '（クライアントが切断されたため中断しました）'
        : '（中断されました）';
      break;
    }
    // 残りステップが少なくなったら収束を促す警告を注入する
    // （予算が小さい場合は最初から警告せず、ツールを使わせる）
    const remaining = maxIterations - i;
    if (maxIterations >= 8 && remaining === 5) {
      messages.push({
        role: 'user',
        content: '（システム: 残りステップはあと 5 回です。調査を打ち切り、わかった範囲で結論をまとめて最終回答を出してください。修正が必要ならこの時点で write_file / edit_file を実行してください。）',
      });
    } else if (maxIterations >= 5 && remaining === 2) {
      messages.push({
        role: 'user',
        content: '（システム: 残りステップはあと 2 回です。ツールを呼ばず、ここまでの結果を日本語で最終回答してください。）',
      });
    }
    const completion = await deps.chat(messages, tools, chatOpts);
    const { message, finishReason, usage } = completion;

    // モデル応答を監査ログへ（本文ハッシュのみ・機密を含めない）
    await audit.emit({
      kind: 'model',
      agentRunId,
      agentStepId: i,
      name: 'chat',
      model: chatOpts.model,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      responseHash: message.content ? sha256(message.content) : undefined,
      meta: {
        finishReason,
        toolCallCount: message.toolCalls.length,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheHitRate: cacheHitRate(usage ?? { promptTokens: 0, completionTokens: 0 }),
      },
    });

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
        opts.onStep?.(steps[steps.length - 1], i);
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
        opts.onStep?.(steps[steps.length - 1], i);
        break;
      }
      // 不完全応答（assistant ターン）を履歴に記録してから続行を促す
      messages.push({
        role: 'assistant',
        content: message.content ?? '',
        reasoning_content: message.reasoning ?? null,
      });
      // 続行を促す user メッセージを追加して再試行（終了を促す方向に緩和）
      messages.push({
        role: 'user',
        content: `（システム: 直前の応答が不完全でした。）\n` +
          `まだ修正が終わっていない場合は、1 回だけツール（write_file / edit_file / run_command）で続けてください。\n` +
          `修正が不要なタスク（質問・調査報告）なら、これ以上ツールを呼ばず、わかったことを日本語で書いた最終回答を返してください。`,
      });
      steps.push({ index: i, message, toolResults, usage: usage ?? { promptTokens: 0, completionTokens: 0 }, ms: completion.ms });
      opts.onStep?.(steps[steps.length - 1], i);
      continue;
    }

    // 不完全応答でなければカウンタをリセット
    emptyReplies = 0;

    // tool_calls を実行する（各ツールの前にも中断を確認する）
    for (const tc of message.toolCalls) {
      if (opts.signal?.aborted) break;
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
      // ツール呼び出しを監査ログへ（引数はシークレットを含まない想定。出力はハッシュのみ）
      await audit.emit({
        kind: 'tool',
        agentRunId,
        agentStepId: i,
        name: tc.name,
        args,
        resultHash: result.output ? sha256(result.output) : undefined,
        ok: result.ok,
        ms: result.ms,
      });
    }

    steps.push({ index: i, message, toolResults, usage: usage ?? { promptTokens: 0, completionTokens: 0 }, ms: completion.ms });
    opts.onStep?.(steps[steps.length - 1], i);

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

  // 安全モード: エージェントの変更を作業ブランチへ commit（可能なら push）する。
  // 人間のレビューと CI を待ってからマージされる（main へ直接は入れない）。
  if (opts.safeMode && safeBranch) {
    const commitMsg = `feat(agent): ${sanitizeText(opts.issue).slice(0, 60)}`;
    const cm = await commitAll(root, commitMsg);
    await audit.emit({ kind: 'system', agentRunId, name: 'commit', meta: { message: cm.message } });
    if (cm.ok) {
      const pd = await pushAndDiff(root, safeBranch);
      await audit.emit({ kind: 'system', agentRunId, name: 'pr', meta: { message: pd.message, diffHash: pd.diff ? sha256(pd.diff) : undefined } });
    }
  }
  await audit.emit({ kind: 'agent', agentRunId, name: 'end', ok: gotFinalAnswer, meta: { stopReason, toolCalls, steps: steps.length } });

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
