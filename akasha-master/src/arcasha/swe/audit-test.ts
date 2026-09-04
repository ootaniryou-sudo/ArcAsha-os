/**
 * 監査ログの検証テスト（append-only + HMAC 署名・改ざん検知）。
 *
 *   npm run swe:audit-test
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLogger, verifyAuditLine, sha256 } from './audit.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-audit-'));
  const secret = 'test-secret';
  const log = createAuditLogger({ dir, secret });
  console.log(`audit dir: ${dir}\n`);

  // emit してファイルに追記されるか
  const a1 = await log.emit({ kind: 'tool', agentRunId: 'r1', agentStepId: 0, name: 'edit_file', args: { path: 'src/a.py' }, ok: true, ms: 10 });
  const a2 = await log.emit({ kind: 'model', agentRunId: 'r1', agentStepId: 0, name: 'chat', model: 'flash', promptTokens: 100, completionTokens: 50 });
  const a3 = await log.emit({ kind: 'agent', agentRunId: 'r1', name: 'end', ok: true });
  check('3 エントリ emit', a1.id !== a2.id && a2.id !== a3.id, '');

  // ファイルが append-only に保存されている
  const raw = await fs.readFile(log.file(), 'utf8');
  const lines = raw.trim().split('\n');
  check('ファイルに 3 行保存', lines.length === 3, `len=${lines.length}`);

  // 署名検証（正しい鍵で通る）
  const parsed = lines.map((l) => JSON.parse(l));
  check('署名が正しい鍵で検証できる', parsed.every((l) => verifyAuditLine(l, secret)), '');
  check('署名が誤った鍵で失敗する', !verifyAuditLine(parsed[0], 'wrong-secret'), '');

  // 改ざん検知: エントリの内容を変えると署名不一致になる
  const tampered = JSON.parse(JSON.stringify(parsed[0]));
  tampered.entry.args = { path: 'src/evil.py' };
  check('改ざんエントリは署名検証に失敗', !verifyAuditLine(tampered, secret), '');

  // ハッシュ
  check('sha256 が 64 文字 hex', sha256('hello').length === 64, sha256('hello'));

  // 新規ロガーでも readAll で読める
  const log2 = createAuditLogger({ dir, secret });
  const all = await log2.readAll();
  check('readAll で 3 エントリ読める', all.length === 3, `len=${all.length}`);

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '✅ ALL PASS — audit' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
