/**
 * KV キャッシュ統計の検証テスト（cacheHitRate / formatCacheHitPercent）。
 *
 * deepseek-harness の手法（出力トークンを分母に入れない・99% 以上の高ヒットを丸めない）を検証。
 */
import { cacheHitRate, formatCacheHitPercent } from './cache-stats.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main(): void {
  // 全キャッシュヒット（入力 0・キャッシュ 100）→ 100%
  check('全キャッシュヒット 100%', cacheHitRate({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 100 }) === 100, '');
  check('format 100%', formatCacheHitPercent({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 100 }) === '100%', '');

  // 部分ヒット（入力 60 + キャッシュ 40 = 40%）
  check('入力 60 + キャッシュ 40 → 40%', cacheHitRate({ promptTokens: 60, completionTokens: 0, cacheReadTokens: 40 }) === 40, '');
  check('format 40%', formatCacheHitPercent({ promptTokens: 60, completionTokens: 0, cacheReadTokens: 40 }) === '40%', '');

  // 高ヒット（入力 1 + キャッシュ 999 → 99.9%）を「100%」に丸めない
  const high = cacheHitRate({ promptTokens: 1, completionTokens: 0, cacheReadTokens: 999 });
  check('高ヒット 99.9% を丸めない', high === 100 && formatCacheHitPercent({ promptTokens: 1, completionTokens: 0, cacheReadTokens: 999 }) !== '100%', `rate=${high} fmt=${formatCacheHitPercent({ promptTokens: 1, completionTokens: 0, cacheReadTokens: 999 })}`);

  // 出力トークンは分母に入れない（入力 50 + 出力 50 + キャッシュ 50 → 50%）
  check('出力は分母に入れない', cacheHitRate({ promptTokens: 50, completionTokens: 50, cacheReadTokens: 50 }) === 50, '');

  // キャッシュなし（入力 100）→ 0%
  check('キャッシュなし 0%', cacheHitRate({ promptTokens: 100, completionTokens: 0, cacheReadTokens: 0 }) === 0, '');
  check('format 0%', formatCacheHitPercent({ promptTokens: 100, completionTokens: 0, cacheReadTokens: 0 }) === '0%', '');

  // 入力なし → null
  check('入力なし → null', cacheHitRate({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 }) === undefined, '');
  check('format 入力なし → null', formatCacheHitPercent({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 }) === null, '');

  console.log(`\n${failures === 0 ? '✅ ALL PASS — cache-stats' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
