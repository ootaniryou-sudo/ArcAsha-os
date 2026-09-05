/**
 * Sandbox Runner の検証テスト（直接実行ランナー・タイムアウト・引数分離）。
 *
 *   npm run swe:sandbox-test
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DirectSandboxRunner, getSandboxRunner } from './sandbox.js';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-sandbox-'));

  // 直接ランナー: 正常コマンド
  const r1 = await new DirectSandboxRunner().run({ command: 'echo hello', cwd: root, timeoutMs: 5000 });
  check('正常コマンド実行（exit 0）', r1.ok && r1.output.includes('hello'), r1.output);

  // 引数分離で実行される（シェルインジェクションなし）
  const r2 = await new DirectSandboxRunner().run({ command: 'echo $HOME', cwd: root, timeoutMs: 5000 });
  // $HOME は展開されない（shell:false）→ リテラル "$HOME" が出る
  check('引数分離（$HOME が展開されない）', r2.ok && r2.output.includes('$HOME') && !r2.output.includes('/Users/'), r2.output);

  // 失敗コマンド（非ゼロ終了）
  const r3 = await new DirectSandboxRunner().run({ command: 'node -e process.exit(3)', cwd: root, timeoutMs: 5000 });
  check('失敗コマンド（exit 3）', !r3.ok && r3.output.includes('3'), r3.output);

  // タイムアウト
  const t0 = Date.now();
  const r4 = await new DirectSandboxRunner().run({ command: 'sleep 5', cwd: root, timeoutMs: 200 });
  check('タイムアウトで強制終了', !r4.ok && r4.output.includes('タイムアウト') && Date.now() - t0 < 3000, r4.output);

  // 存在しないコマンド
  const r5 = await new DirectSandboxRunner().run({ command: 'no-such-cmd-xyz', cwd: root, timeoutMs: 1000 });
  check('存在しないコマンドはエラー', !r5.ok, r5.output);

  // 無制限出力コマンド（yes）が出力上限で終了する（メモリ枯渇防止）
  const r6 = await new DirectSandboxRunner().run({ command: 'yes', cwd: root, timeoutMs: 5000 });
  check('無制限出力（yes）は出力上限で終了', !r6.ok && r6.output.includes('出力上限'), r6.output.slice(0, 200));

  // 設定ランナー（env 既定 = direct）
  const g = getSandboxRunner();
  check('getSandboxRunner が direct を返す', g.id === 'direct' && (await g.available()), g.id);

  await fs.rm(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '✅ ALL PASS — sandbox' : `❌ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
