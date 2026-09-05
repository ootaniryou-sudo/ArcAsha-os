/**
 * Chat 記録保存の検証テスト（時系列ログの append-only 保存）。
 *
 *   npm run assistant:chatlog-test
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatLog } from './chat-log.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-chatlog-'));
  const log = createChatLog(dir);
  console.log(`chat-log dir: ${dir}\n`);

  // user / assistant / system の発言を追記
  const u = await log.append({ threadId: 't1', role: 'user', content: 'こんにちは', mode: 'casual' });
  const a = await log.append({ threadId: 't1', role: 'assistant', content: 'こんにちは！', model: 'deepseek-v4-flash', mode: 'casual', kind: 'chat', promptTokens: 10, completionTokens: 5 });
  await log.append({ threadId: 't2', role: 'system', content: '新しい会話' });

  // エントリに ts が付与される
  check('user エントリに ts', !!u.ts && u.role === 'user', JSON.stringify(u));
  check('assistant エントリに model/kind', a.role === 'assistant' && a.model === 'deepseek-v4-flash' && a.kind === 'chat', '');

  // ファイルに 3 行（append-only）
  const raw = await fs.readFile(log.file(), 'utf8');
  const lines = raw.trim().split('\n');
  check('ファイルに 3 行保存', lines.length === 3, `len=${lines.length}`);

  // 追記すると 4 行になる（既存を壊さない）
  await log.append({ threadId: 't1', role: 'user', content: '続き' });
  const raw2 = await fs.readFile(log.file(), 'utf8');
  check('追記で 4 行（append-only）', raw2.trim().split('\n').length === 4, '');

  // all() で全件読める
  const all = await log.all();
  check('all() で 4 エントリ', all.length === 4, `len=${all.length}`);

  // count()
  check('count() = 4', (await log.count()) === 4, String(await log.count()));

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '✅ ALL PASS — chat-log' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
