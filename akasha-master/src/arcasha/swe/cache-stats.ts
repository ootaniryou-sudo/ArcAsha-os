/**
 * KV キャッシュ統計 — DeepSeek のプロンプトキャッシュヒット率の計算・表示
 *
 * deepseek-harness の手法を移植:
 *   - cacheHitRate = round(cacheRead / (input + cacheRead + cacheWrite) * 100)
 *     キャッシュヒット率は「プロンプトの属性」。出力トークンは分母に入れない
 *     （出力はキャッシュされないため、分母に足すと率が無意味に下がる）。
 *   - formatCacheHitPercent: 99.99% のような高ヒットを「100%」に丸めず表示する。
 */
import type { ChatUsage } from './types.js';

/** キャッシュヒット率（0..100）。分母が 0 なら undefined。 */
export function cacheHitRate(u: ChatUsage): number | undefined {
  const input = u.promptTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const denom = input + cacheRead + cacheWrite;
  if (denom === 0) return undefined;
  return Math.round((cacheRead / denom) * 100);
}

/** 表示用のキャッシュヒット率文字列（例: "42%", "100%", "99.9%"）。無ければ null。 */
export function formatCacheHitPercent(u: ChatUsage): string | null {
  const input = u.promptTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  if (input === 0 && cacheRead === 0) return null;
  const denom = input + cacheRead + (u.cacheWriteTokens ?? 0);
  if (denom === 0) return null;
  const exact = (cacheRead / denom) * 100;
  // 99% 以上 100% 未満の高ヒットは小数1桁まで出す（99.9% 等）。丸めで「100%」と誤表示しない。
  if (exact >= 99 && exact < 100) return `${exact.toFixed(1)}%`;
  return `${Math.round(exact)}%`;
}
