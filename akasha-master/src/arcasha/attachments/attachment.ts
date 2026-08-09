/**
 * Attachment（Phase 3.0）— 高度な知能を OS 本体から分離したプラグイン層
 *
 *   ArcAsha Core（Kernel / Runtime / Executive / AVM）は小さく安定。
 *   高度な知能（Reflection / Debate / Planning / Search / Creativity /
 *   Simulation / Coding）はすべて Attachment（オプションのカーネルモジュール）として
 *   必要時にだけロードする（Linux のオプションカーネルモジュールと同様の思想）。
 *
 *   - Attachment は Kernel 状態を直接変更しない
 *   - 全ての通信は Executive Runtime を経由する
 *   - AVM のみを使い、Context は ContextRef でしか交換しない
 *   - 遅延ロード（load されるまで実体を生成しない）
 */

import type { BootResult } from '../ailsm/expert-runtime.js';

/** Attachment のメタ情報（Executive のスケジューリングに使う Thinking Budget） */
export interface AttachmentMeta {
  id: string;
  name: string;
  version: string;
  estimatedCost: number; // 0-1 推定コスト
  estimatedLatency: number; // 推定レイテンシ（ms）
  estimatedAccuracy: number; // 0-1 推定精度
}

/** Attachment 実行コンテキスト（Kernel 状態へは直接触れない） */
export interface AttachmentContext {
  text: string; // タスク文
  booted: BootResult; // Expert 実行資源
  attach: (id: string) => Promise<AttachmentResult | null>; // 子 Attachment の呼び出し
}

export interface AttachmentResult {
  ok: boolean;
  text: string; // 成果テキスト
  quality: number; // 0-1 品質
  latencyMs: number; // 実測（または推定）
  calls: number; // Expert / 子 Attachment 呼び出し数
  tokens: number; // 推定トークン使用
  detail: string[]; // 内部パイプラインログ
}

/** Attachment インターフェース（全プラグインが実装） */
export interface Attachment extends AttachmentMeta {
  enabled: boolean;
  supports(taskText: string): boolean;
  run(context: AttachmentContext): Promise<AttachmentResult>;
}

/** トークン推定（文字数ベースの決定論近似） */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 2));
}

/** 結果の簡易生成 */
export function makeResult(
  text: string,
  quality: number,
  latencyMs: number,
  calls: number,
  detail: string[],
  tokens?: number,
): AttachmentResult {
  // quality は有限値のみ受け入れ、NaN / Infinity は 0 にクランプ（不正入力の防御）
  const q = Number.isFinite(quality) ? Math.min(1, Math.max(0, quality)) : 0;
  return { ok: true, text, quality: q, latencyMs, calls, tokens: tokens ?? estimateTokens(text), detail };
}

/** 複数 Attachment の結果を統合（並列実行後のマージ）— 品質は最良の成果を採用 */
export function mergeResults(id: string, results: AttachmentResult[], sep = ' '): AttachmentResult {
  const texts = results.filter((r) => r.ok).map((r) => r.text);
  return {
    ok: results.length > 0 && results.every((r) => r.ok),
    text: texts.join(sep),
    quality: results.reduce((m, r) => Math.max(m, r.quality), 0),
    latencyMs: Math.max(0, ...results.map((r) => r.latencyMs)),
    calls: results.reduce((s, r) => s + r.calls, 0),
    tokens: results.reduce((s, r) => s + r.tokens, 0),
    detail: [`MERGE(${id}): ${results.length} 結果を統合（最良品質 ${results.reduce((m, r) => Math.max(m, r.quality), 0).toFixed(2)}）`, ...results.flatMap((r) => r.detail)],
  };
}
