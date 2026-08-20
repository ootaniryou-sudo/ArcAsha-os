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

/** フォールバック選択を構造化ログで出力（運用時の追跡用） */
function logSelection(requested: HarnessKind, resolved: string, probeMs: number): void {
  const record = { harness: { requested, resolved, probeMs } };
  if (requested === resolved) {
    console.log(`[harness] selected ${resolved}`, record);
  } else {
    console.warn(`[harness] ${requested} unavailable → fallback to ${resolved}`, record);
  }
}

/**
 * 優先順位に従って Harness を解決する。
 * - preferred = 'deepseek' で dsh が利用可能 → DeepSeekHarnessAdapter
 * - probe が reject / false の場合も含め、それ以外 → NativeHarness（フォールバック）
 *
 * @param adapterFactory テスト用に差し替え可能（既定: 実プローブのアダプタ）
 */
export async function resolveHarness(
  preferred: HarnessKind = 'deepseek',
  adapterFactory: () => DeepSeekHarnessAdapter = () => new DeepSeekHarnessAdapter(),
): Promise<Harness> {
  const started = performance.now();
  if (preferred === 'deepseek') {
    const adapter = adapterFactory();
    // プローブの失敗（reject）も unavailable として扱い、Native へフォールバックする
    const ok = await adapter.available().catch(() => false);
    if (ok) {
      logSelection(preferred, 'deepseek', performance.now() - started);
      return adapter;
    }
    logSelection(preferred, 'native', performance.now() - started);
    return new NativeHarness();
  }
  logSelection(preferred, 'native', performance.now() - started);
  return new NativeHarness();
}
