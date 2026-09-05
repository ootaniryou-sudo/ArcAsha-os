/**
 * フィードバック保存の検証テスト（👍/👎 + 理由の保存・統計）。
 *
 *   npm run assistant:feedback-test
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeedbackStore } from './feedback.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-fb-'));
  const store = createFeedbackStore(dir);
  console.log(`feedback dir: ${dir}\n`);

  // good + 理由
  const g = await store.add({ rating: 'good', threadId: 't1', model: 'flash', mode: 'casual', prompt: '2+2は?', response: '4です', reason: '簡潔で分かりやすかった' });
  check('good フィードバック保存', g.rating === 'good' && g.reason === '簡潔で分かりやすかった', JSON.stringify(g));

  // bad + 理由
  const b = await store.add({ rating: 'bad', threadId: 't1', model: 'flash', mode: 'casual', prompt: 'バグ修正して', response: '修正しました', reason: '修正が間違っていた' });
  check('bad フィードバック保存', b.rating === 'bad' && b.reason === '修正が間違っていた', '');

  // 理由なしの good
  await store.add({ rating: 'good', threadId: 't2', model: 'pro', mode: 'expert', prompt: 'x', response: 'y' });

  // ファイルに 3 行保存
  const raw = await fs.readFile(store.file(), 'utf8');
  const lines = raw.trim().split('\n');
  check('ファイルに 3 行保存', lines.length === 3, `len=${lines.length}`);

  // 統計
  const stats = await store.stats();
  check('統計 good=2 / bad=1', stats.good === 2 && stats.bad === 1 && stats.total === 3, JSON.stringify(stats));

  // readAll（学習用）
  const all = await store.all();
  check('readAll で 3 件読める', all.length === 3, `len=${all.length}`);

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '✅ ALL PASS — feedback' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
