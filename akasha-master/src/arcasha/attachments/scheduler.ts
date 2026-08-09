/**
 * Attachment Scheduler（Phase 3.0）— Executive が参加 Attachment を選択する
 *
 *   Executive は「どの Attachment を / いつ / どれだけの予算で / どの優先度で」を
 *   決める（Thinking Budget: estimatedCost / estimatedLatency / estimatedAccuracy）。
 *
 *   優先度 = 推定精度 − コスト罰 − レイテンシ罰（Executive の selectionScore と同型）
 *   予算 = 残り予算に応じて配分。並列実行して結果を統合する。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { mergeResults } from './attachment.js';
import type { AttachmentManager } from './manager.js';

export interface ScheduledAttachment {
  id: string;
  priority: number;
  budget: number; // 0-1 割り当て予算
}

/** 実行優先度: 精度を上げ、コストとレイテンシを罰する（探索 vs 活用の selectionScore と同型） */
export function attachmentPriority(a: Attachment): number {
  return a.estimatedAccuracy - a.estimatedCost * 0.5 - a.estimatedLatency / 10000;
}

/**
 * Executive の選択: supports + enabled を満たす Attachment を優先度順に選び、
 * 予算（0-1）を配分する。予算が足りなければ低優先度を外す。
 */
export function attachmentScheduler(
  manager: AttachmentManager,
  taskText: string,
  opts: { budget?: number; max?: number } = {},
): ScheduledAttachment[] {
  const budget = opts.budget ?? 1.0;
  const max = opts.max ?? Infinity;
  // 不正な予算・上限（NaN・負数）は空結果として安全に返す。
  // ただし max はデフォルト Infinity（上限なし）なので Infinity は許可する。
  if (Number.isNaN(budget) || budget < 0) return [];
  if (Number.isNaN(max) || max < 0) return [];
  const pool = manager.list().filter((a) => a.enabled && a.supports(taskText)).sort((a, b) => attachmentPriority(b) - attachmentPriority(a));
  const out: ScheduledAttachment[] = [];
  let remaining = budget;
  for (const a of pool) {
    if (out.length >= max) break;
    if (a.estimatedCost > remaining) continue; // 予算不足
    out.push({ id: a.id, priority: attachmentPriority(a), budget: a.estimatedCost });
    remaining -= a.estimatedCost;
  }
  return out;
}

/** Executive → スケジューラ → 並列実行 → 統合 の一連（Fast Runtime を乱さず必要時だけ動かす） */
export async function runWithAttachments(
  manager: AttachmentManager,
  ctx: AttachmentContext,
  opts: { budget?: number; max?: number; label?: string } = {},
): Promise<{ scheduled: ScheduledAttachment[]; result: AttachmentResult }> {
  const scheduled = attachmentScheduler(manager, ctx.text, opts);
  const ids = scheduled.map((s) => s.id);
  if (ids.length === 0) {
    return { scheduled, result: { ok: true, text: ctx.text, quality: 0.5, latencyMs: 0, calls: 0, tokens: 0, detail: ['NO_ATTACHMENT'] } };
  }
  const results = await manager.executeParallel(ids, ctx);
  const result = mergeResults(opts.label ?? 'executive', ids.map((id) => results[id]));
  return { scheduled, result };
}
