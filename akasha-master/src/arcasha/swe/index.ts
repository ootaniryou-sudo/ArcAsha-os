/**
 * SWE-bench エージェント — 公開出口。
 *
 * 提供物:
 *   - runSweAgent   : ツールループエージェント（リポジトリ読解 → 編集 → テスト実行 → 最終回答）
 *   - SWE_TOOLS     : エージェントが使えるツール群
 *   - chatCompletion: function calling 対応のモデルクライアント
 *   - types         : SweTool / SweAgentResult など
 */
export { runSweAgent, type SweAgentOptions } from './agent.js';
export { SWE_TOOLS, getSweTool } from './tools.js';
export { chatCompletion, chatDefaults, toChatTools, type ChatMessage } from './model.js';
export type {
  SweTool,
  SweContext,
  SweToolResult,
  SweToolParameter,
  SweAgentResult,
  SweStep,
  ChatToolCall,
  ChatResponseMessage,
  ChatOptions,
  ChatUsage,
} from './types.js';
