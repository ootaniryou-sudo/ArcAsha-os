/**
 * Intelligence Runtime 契約の自己テスト（mock モード・API 不要）
 *
 * プラグイン境界（Runtime Contract）が「独立して動く」ことを検証する:
 *   - capabilities() が能力を公開する
 *   - submit() が契約通りの RuntimeResult を返す（ok / answer / kind / memory / trace）
 *   - タスク分類とルーティングが機能する（forceKind）
 *   - status() が艦隊情報を返す
 */
import { createIntelligenceRuntime } from './runtime-contract.js';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean): void {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

async function main(): Promise<void> {
  console.log('[plugin] Intelligence Runtime 契約 selftest（mock）');
  const rt = createIntelligenceRuntime({ forceMock: true, verbose: false, memory: true });

  // 1) 能力公開
  const caps = rt.capabilities();
  check('capabilities が 3 つ以上公開される', caps.length >= 3);
  check('aios-execute 能力を含む', caps.some((c) => c.name === 'aios-execute'));

  // 2) submit（数学タスク → math / reasoning 系モデルへ）
  const r = await rt.submit({ task: '2 と 3 を足すといくつ？', forceKind: 'math' });
  check('ok = true', r.ok === true);
  check('answer が非空', typeof r.answer === 'string' && r.answer.length > 0);
  check('kind = math', r.kind === 'math');
  check('expert ラベルが設定されている', r.expert.length > 0);
  check('model / nodeId が設定されている', r.model.length > 0 && r.nodeId.length > 0);
  check('memory 統計が数値（reads/writes/modelCalls）', typeof r.memory.reads === 'number' && typeof r.memory.modelCalls === 'number');
  check('trace に classify が含まれる', r.trace.some((t) => t.includes('classify')));

  // 3) 自動分類（一般タスク → general）
  const g = await rt.submit({ task: 'こんにちは' });
  check('自動分類で kind が決まる', g.kind === 'general');

  // 4) status
  const s = rt.status();
  check('status.nodes > 0（mock 2 台）', s.nodes > 0);
  check('status.fleet が空でない', s.fleet.length > 0);

  console.log('');
  console.log(`  ${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'} — plugin contract: ${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
