/**
 * Harness Registry — Native / DeepSeek を選択し、DSH 不可なら Native にフォールバック。
 *
 * Rollback Safety（仕様書 §36）:
 *   DeepSeek unavailable → fallback to Native → ArcAsha continues
 */
import type { Harness } from './harness.js';
import { NativeHarness } from './native.js';
import { DeepSeekHarnessAdapter } from './deepseek.js';

export type HarnessKind = 'native' | 'deepseek';

/** 指定された Harness を生成（同期）。 */
export function createHarness(kind: HarnessKind = 'native'): Harness {
  return kind === 'deepseek' ? new DeepSeekHarnessAdapter() : new NativeHarness();
}

/**
 * 優先順位に従って Harness を解決する。
 * - preferred = 'deepseek' で dsh が利用可能 → DeepSeekHarnessAdapter
 * - それ以外 → NativeHarness（フォールバック）
 *
 * @param adapterFactory テスト用に差し替え可能（既定: 実プローブのアダプタ）
 */
export async function resolveHarness(
  preferred: HarnessKind = 'deepseek',
  adapterFactory: () => DeepSeekHarnessAdapter = () => new DeepSeekHarnessAdapter(),
): Promise<Harness> {
  if (preferred === 'deepseek') {
    const adapter = adapterFactory();
    if (await adapter.available()) return adapter;
  }
  return new NativeHarness();
}
