/**
 * AILSM Phase 0.5 — セルフテスト（Stage 1 決定論 + Stage 3 決定論Verifier）
 *
 * 実行: npx tsx src/arcasha/ailsm/selftest.ts
 */

import { rm } from 'node:fs/promises';
import { Slot, Task } from '../ailsa/vocab.js';
import { MathOpcode } from '../ailsa/dialect.js';
import { Opcode, SyscallOpcode } from '../ailsa/opcode.js';
import type { Instruction } from '../ailsa/encoder.js';
import { AiProgram } from './program.js';
import { link } from './linker.js';
import { optimizeInstructions } from './optimizer.js';
import { compile, compileAndRun, describeGraph, toHex } from './compiler.js';
import { tokenize } from './lexer.js';
import { normalize } from './normalizer.js';
import { execute } from './executor.js';
import { run } from './runtime.js';
import { canTransition, believe, plan, reflect, remember } from './state.js';
import { pickNext } from './scheduler.js';
import type { ScheduledUnit } from './scheduler.js';
import { AIKernel, isKernelNode } from './kernel.js';
import { assignNamespace, canAccessMemory, createNamespace, loadPage, pageMemory } from './namespace.js';
import { ABI_VERSION_1_0, buildContextArgument, supportsAbi } from './abi.js';
import type { AbiArgument } from './abi.js';
import { MockExpertDriver } from './driver.js';
import { DeviceTree } from './device-tree.js';
import { boot, execute as runtimeExecute } from './expert-runtime.js';
import { toAsciiTree, toDot, toMermaid, toStateDiagram } from './visualizer.js';
import { createContext, contextOf, pagesOf, splitContext } from './context.js';
import { loadPage as loadContextPage } from './context.js';
import { hasEquation, selectPages } from './slice.js';
import { cacheArtifact, getCached } from './cache.js';
import { requestSlice, runAvmDemo, storeContext, cacheResult, runExecutionDemo, runMemoryHierarchyDemo } from './avm.js';
import { createExecutionContext, contextSwitch, saveExecutionContext, restoreExecutionContext, updateExecution, executionOf, commitMemory, pushFrame, popFrame, mergeFrames, frameOf } from './execution.js';
import { contextFault, prefetch, isResident } from './demand-paging.js';
import { splitChunks, splitSpans, spanKindOf, subdivideContext, spansOfKind } from './chunk.js';
import { ContextTlb, translateSpan } from './context-tlb.js';
import { TierManager } from './tier.js';
import { AiPerf } from './perf.js';
import { AiTrace, buildRuntimeTrace, buildSchedulerTrace, renderTimeline } from './trace.js';
import { AiProfiler } from './profiler.js';
import { defaultQuestions, pageKindOfIndex, runLongContextBenchmark, synthesizeContext } from './benchmark.js';
import { runObservabilityDemo } from './observability.js';
import { MockModelClient } from './model-client.js';
import { RemoteDriver } from './remote-driver.js';
import { runRelay } from './relay.js';
import { registerHubDevices, routeCall, assignPageDevice, pageDevice, distributedFault } from './device-router.js';
import { CapabilityLearner, updateCapabilitySsa } from './learning.js';
import { initAiOs, aiosExecute, aiosRelay } from './aios.js';
import { AilsmBuilder } from './ailsm.js';
import { runComparisonBenchmark } from './comparison.js';
import { runScalingExperiment, renderScaling } from './experiment.js';
import { hypothesize, activate, evaluate, accept, merge, hypothesesOf, hypothesisOf, expand, childrenOf, markExpanded } from './reasoning.js';
import { runReasoning, runReasoningDemo, defaultHypothesisGenerator } from './reasoning-runtime.js';
import { selectionScore, BeamSearchPolicy, BestFirstPolicy, DFSPolicy, BFSPolicy, MctsPolicy } from './search.js';
import { runSearchDemo, renderSearch } from './reasoning-search.js';
import { executive, executivesOf, executiveOf, updateExecutive } from './executive.js';
import { runExecutiveDemo, renderExecutive, defaultDecide } from './executive-runtime.js';
import { metaExecutive, updateMetaExecutive, metaExecutiveOf, metaExecutivesOf, estimateBudget } from './meta-executive.js';
import { runMetaExecutiveDemo, renderMetaExecutive } from './meta-executive-runtime.js';
import { expert, expertsOf, expertOf, computeHealth, shouldSplit, shouldMerge, shouldRetire, splitExpert, mergeExperts, retireExpert } from './expert-evolution.js';
import { runExpertEvolutionDemo, renderExpertEvolution } from './expert-evolution-runtime.js';
import { AttachmentManager } from '../attachments/manager.js';
import { AttachmentMonitor } from '../attachments/observability.js';
import { BUILTIN_ATTACHMENT_IDS, registerBuiltinAttachments } from '../attachments/builtin.js';
import { attachmentScheduler } from '../attachments/scheduler.js';
import { makeResult } from '../attachments/attachment.js';
import { runAttachmentBenchmark } from '../attachments/benchmark.js';
import { resolvePipeline, intelligenceScheduler, runThinking, renderThinking, runThinkingBenchmark } from '../attachments/modes.js';
import { runModeValidation, runAblation, runRobotSimulation, estimatePower, renderModeValidation, renderAblation, renderRobotSimulation } from '../attachments/validation.js';
import { SCIENTIFIC_CORPUS, modeQuality, runReasoningBenchmark, runLongContextValidation, runRobotValidation, runExecutiveValidation, runModelComparison } from '../attachments/scientific.js';
import { ALL_BENCH_SUITES, runExternalBenchmarks, overallAccuracy } from '../bench/run.js';
import { configQuality } from '../bench/types.js';
import type { BenchResultRow } from '../bench/run.js';
import type { BenchSuite } from '../bench/types.js';
import { renderCaravanBenchmark } from '../bench/caravan.js';
import { osOverheadProfile, allOverheadProfiles } from '../bench/overhead.js';
import { buildJsonReport, buildCsvReport, buildMarkdownReport, writeReports, VALIDATION_KIND } from '../bench/report.js';
import { explainExecutive, renderExplanation } from '../attachments/explain.js';
import { runRealDeviceBenchmark, renderRealDeviceBenchmark, renderRealDevicePlan, REAL_DEVICE_PROFILE } from '../bench/real-device.js';
import { DecisionLog, learnGains, explainWithPolicy, runPolicyLearningDemo } from '../attachments/decision-log.js';
import { captureReplay, renderReplay, renderReplayStep, replayStepCount } from '../attachments/replay.js';
import { runCli } from '../cli.js';
import type { AttachmentContext } from '../attachments/attachment.js';
import type { Hypothesis } from './reasoning.js';
import type { Harness } from '../harness/harness.js';

let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name} ${detail}`);
  }
}

function expectThrow(name: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ FAIL: ${name}（例外が投げられなかった）`);
  } catch (e) {
    console.log(`  ✓ ${name}（${(e as Error).message}）`);
  }
}

/** async 関数の例外送出を検証する（Promise の reject を捕捉） */
async function expectThrowAsync(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    failed++;
    console.error(`  ✗ FAIL: ${name}（例外が投げられなかった）`);
  } catch (e) {
    console.log(`  ✓ ${name}（${(e as Error).message}）`);
  }
}

console.log('═'.repeat(60));
console.log('  AILSM Phase 0.5 — Self Test');
console.log('═'.repeat(60));

async function main(): Promise<void> {

// [1] 方程式を解く
console.log('\n[1] 方程式');
const r1 = compile('x+2=5を解いて');
check('intent=solve', r1.normalized.intent === 'solve');
check('domain=math', r1.normalized.domain === 'math');
check('rawMath 抽出', r1.normalized.rawMath.includes('x+2=5'));
check('EQ 命令が含まれる', r1.instructions.some((i) => i.opcode === MathOpcode.EQ));
check('AILSA 検証 valid', r1.verification.valid);
check('バイト列が生成される', r1.bytes.length > 0);
console.log('  --- AILSM ---');
console.log(`  ${describeGraph(r1.semantic.graph).split('\n').join('\n  ')}`);
console.log(`  --- AILSA hex: ${toHex(r1.bytes)} ---`);

// [2] 円の面積（オブジェクト・属性・出力の抽出）
console.log('\n[2] 円の面積');
const r2 = compile('半径5の円の面積を求めて');
check('object=circle', r2.normalized.objects.includes('circle'));
check('attr radius=5', r2.normalized.attributes.some((a) => a.name === 'radius' && a.value === '5'));
check('output=area', r2.normalized.output === 'area');
check('domain=math', r2.normalized.domain === 'math');
check('valid', r2.verification.valid);

// [3] 同義語の正準化（Normalization）
console.log('\n[3] 同義語正準化');
const a3 = compile('足してください');
const b3 = compile('加えて');
const c3 = compile('和を求めよ');
check(
  '3表現とも ACTION_ADD',
  a3.normalized.actions[0] === 'ACTION_ADD' &&
    b3.normalized.actions[0] === 'ACTION_ADD' &&
    c3.normalized.actions[0] === 'ACTION_ADD',
);

// [4] 積分（Math Dialect オペコード）
console.log('\n[4] 積分');
const r4 = compile('x^2 を積分して');
check('intent=solve', r4.normalized.intent === 'solve');
check('ACTION_INTEGRAL', r4.normalized.actions.includes('ACTION_INTEGRAL'));
check('INTEGRAL 命令', r4.instructions.some((i) => i.opcode === MathOpcode.INTEGRAL));
check('valid', r4.verification.valid);

// [5] 要約（Registry v1.1.0 の TASK_SUMMARIZE）
console.log('\n[5] 要約');
const r5 = compile('この文章を要約して');
check('intent=summarize', r5.normalized.intent === 'summarize');
check('domain=reasoning', r5.normalized.domain === 'reasoning');
check('TASK_SUMMARIZE 命令', r5.instructions.some((i) => i.opcode === Task.SUMMARIZE));
check('valid', r5.verification.valid);

// [6] 検索（Back-End: expert=search へルーティング）
console.log('\n[6] 検索');
const r6 = compile('Webから記事を検索して');
check('intent=search', r6.normalized.intent === 'search');
const call = r6.instructions.find((i) => i.opcode === 0x30);
check('expert=search', call?.slots?.find((s) => s.slot === Slot.EXPERT)?.value === 'search');
check('valid', r6.verification.valid);

// [7] 失敗系（壊れない土台）
console.log('\n[7] 失敗系');
expectThrow('空入力は例外', () => compile(''));
expectThrow('解釈不能は例外（Stage 2 委譲点）', () => compile('こんにちは世界'));

// [8] 決定論
console.log('\n[8] 決定論');
const ra = compile('x+2=5を解いて').bytes;
const rb = compile('x+2=5を解いて').bytes;
check('同じ入力 → 同じバイト列', ra.every((v, i) => v === rb[i]));

// [9] Optimizer / Capability / 定数畳み込み / 制約
console.log('\n[9] Optimizer / Capability / Fold');
const r9 = compile('2+3を計算して');
check('定数畳み込みノート', r9.notes.some((n) => n.includes('constant fold')));
check('fold 結果が INPUT=5', r9.instructions.some((i) => i.slots?.some((s) => s.slot === Slot.INPUT && s.value === '5')));
check('能力推論 expert=math', r9.capability.expert === 'math');
check('能力推論 requiredTypes に number', r9.capability.requiredTypes.includes('number'));

const r9b = compile('x^2を積分して', 0); // -O0
const r9c = compile('x^2を積分して', 2); // -O2
check('-O0 / -O2 で命令列が一致（畳み込み対象なし）', r9b.instructions.length === r9c.instructions.length);

const r10 = compile('半径3の円の面積を求めて');
const radiusNode = r10.semantic.graph.nodes.find((n) => n.kind === 'value' && n.label === 'radius');
check('制約 min=0 が付与', radiusNode?.constraints?.min === 0);

// [10] Visualizer（見えるIR）
console.log('\n[10] Visualizer');
const rv = compile('x+2=5を解いて');
const mm = toMermaid(rv.optimized.graph);
const dot = toDot(rv.optimized.graph);
const tree = toAsciiTree(rv.optimized.graph);
check('Mermaid に Task#1 が含まれる', mm.includes('Task#1'));
check('Mermaid に uses エッジ', mm.includes('-->|uses|'));
check('DOT に digraph 宣言', dot.includes('digraph AILSM'));
check('ASCII ツリーに Object#2', tree.includes('Object#2'));
console.log('  --- Mermaid ---');
console.log(mm.split('\n').map((l) => `  ${l}`).join('\n'));

// [11] AILSM Executor（IRをLLM無しで実行）
console.log('\n[11] AILSM Executor');
const e1 = execute(compile('2と3を足して').optimized.graph);
check('ADD 解決 2+3=5', e1.resolved && e1.value === 5, String(e1.value));
check('Result ノード追加', e1.after.nodes.some((n) => n.kind === 'value' && n.label === 'result' && n.attrs.value === 5));
check('needsExpert=false', e1.needsExpert === false);
check('ステップ記録', e1.steps.some((s) => s.includes('ACTION_ADD')));

const e2 = execute(compile('20を4で割って').optimized.graph);
check('DIVIDE 解決 20÷4=5', e2.resolved && e2.value === 5, String(e2.value));
const e3 = execute(compile('9の平方根を求めて').optimized.graph);
check('SQRT 解決 √9=3', e3.resolved && e3.value === 3, String(e3.value));
const e4 = execute(compile('x^2を積分して').optimized.graph);
check('積分は Expert 委譲（needsExpert）', e4.needsExpert === true && e4.resolved === false);

const cr = compileAndRun('7と6を掛けて');
check('compileAndRun で 7×6=42', cr.execution.resolved && cr.execution.value === 42);

// [12] AI State SSA（Memory / Belief / Plan / Reflection）
console.log('\n[12] AI State SSA');
const gbase = compile('x^2を積分して').optimized.graph;
const taskId0 = gbase.nodes.find((n) => n.kind === 'task')?.id ?? 0;

const mem = remember(gbase, taskId0, 'result', 5);
check('Memory# ノード追加', mem.graph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'result' && n.attrs.value === 5));
const bel = believe(mem.graph, taskId0, 'math', 0.82);
check('Belief# ノード追加（confidence=0.82）', bel.graph.nodes.some((n) => n.kind === 'belief' && n.attrs.confidence === 0.82 && n.attrs.expert === 'math'));
const pln = plan(bel.graph, taskId0, ['DECOMPOSE', 'CALL math']);
check('Plan# ノード追加', pln.graph.nodes.some((n) => n.kind === 'plan'));
const refl = reflect(pln.graph, taskId0, 'precision', 'switch backend');
check('Reflection# ノード追加', refl.graph.nodes.some((n) => n.kind === 'reflection' && n.attrs.cause === 'precision'));

// Runtime: ローカル解決 → Memory SSA
const rt1 = run('2と3を足して');
check('runtime: ローカル解決 → Memory SSA', rt1.graph.nodes.some((n) => n.kind === 'memory'));
check('runtime: resolvedValue=5', rt1.resolvedValue === 5);
check('runtime: needsExpert=false', rt1.needsExpert === false);

// Runtime: Expert委譲 → Belief SSA → CALL
const rt2 = run('x^2を積分して');
check('runtime: 積分 → Belief SSA（expert=math）', rt2.graph.nodes.some((n) => n.kind === 'belief' && n.attrs.expert === 'math'));
check('runtime: needsExpert=true', rt2.needsExpert === true);
check('runtime: CALL step 記録', rt2.steps.some((s) => s.kind === 'call'));

// 状態遷移図
const sd = toStateDiagram(rt2.steps);
check('stateDiagram-v2 出力', sd.includes('stateDiagram-v2'));
check('stateDiagram に Belief', sd.includes('Belief:'));
console.log('  --- State Diagram ---');
console.log(sd.split('\n').map((l) => `  ${l}`).join('\n'));

// [13] Scheduler / Capability SSA（ODAR = SSA）
console.log('\n[13] Scheduler / Capability SSA');
const rt3 = run('x^2を積分して');
check(
  'Capability# ノード（acc/latency/cost）',
  rt3.graph.nodes.some((n) => n.kind === 'capability' && n.attrs.expert === 'math' && typeof n.attrs.accuracy === 'number'),
);
check(
  'Schedule# ノード（priority/ETA）',
  rt3.graph.nodes.some((n) => n.kind === 'schedule' && typeof n.attrs.priority === 'number' && typeof n.attrs.eta === 'number'),
);
check(
  'トレース: Process→Thread→Belief→Capability→Schedule→CALL→WAIT',
  rt3.steps.map((s) => s.kind).join(',') === 'input,compile,process,thread,belief,capability,schedule,call,wait',
  rt3.steps.map((s) => s.kind).join(','),
);
const sd3 = toStateDiagram(rt3.steps);
check('stateDiagram に Schedule', sd3.includes('Schedule:'));

// [14] AI Process / Thread / Reasoning Scheduler（AI OS）
console.log('\n[14] AI Process / Thread / Scheduler');
const rt4 = run('x^2を積分して');
check('Process# ノード（owner=math）', rt4.graph.nodes.some((n) => n.kind === 'process' && n.attrs.owner === 'math'));
check('Thread# ノード', rt4.graph.nodes.some((n) => n.kind === 'thread'));
check('CALL中は Process waiting', rt4.graph.nodes.some((n) => n.kind === 'process' && n.attrs.state === 'waiting'));
check(
  'Runtime Events: SPAWN/CALL/WAIT',
  rt4.events.some((e) => e.kind === 'SPAWN') && rt4.events.some((e) => e.kind === 'CALL') && rt4.events.some((e) => e.kind === 'WAIT'),
);

const rt5 = run('2と3を足して');
check('ローカル解決は Process finished', rt5.graph.nodes.some((n) => n.kind === 'process' && n.attrs.state === 'finished'));
check('FINISH イベント', rt5.events.some((e) => e.kind === 'FINISH'));

const units: ScheduledUnit[] = [
  { processId: 1, priority: 0.4, owner: 'code', state: 'ready' },
  { processId: 2, priority: 0.9, owner: 'math', state: 'ready' },
  { processId: 3, priority: 0.9, owner: 'search', state: 'ready' },
  { processId: 4, priority: 0.7, owner: 'code', state: 'waiting' },
];
check('pickNext: 最高優先度（同点は低ID）', pickNext(units)?.processId === 2);
check('created→ready 遷移可', canTransition('created', 'ready'));
check('finished→running 遷移不可', !canTransition('finished', 'running'));

// [15] AI Kernel / System Call（Kernel-mediated AI Runtime）
console.log('\n[15] AI Kernel / System Call');
const rtK = run('x^2を積分して');
const pidK = rtK.processId!;
const k = new AIKernel();

const ms = k.memoryStore(rtK.graph, pidK, 'answer', 42);
check('SYSCALL_MEMORY_STORE granted', ms.granted);
check('Memory ノード追加（Kernel経由）', ms.graph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'answer' && n.attrs.value === 42));
check('SYSCALL_MEMORY_LOAD value=42', k.memoryLoad(ms.graph, pidK, 'answer').value === 42);
check('SYSCALL_MEMORY_QUERY で answer 検出', (k.memoryQuery(ms.graph, pidK, 'answ').value as string[]).includes('answer'));
check('同owner の MEMORY_DELETE は granted', k.memoryDelete(ms.graph, pidK, 'answer', 'math').granted);
const mdDenied = k.memoryDelete(ms.graph, pidK, 'answer', 'code');
check('別owner への DELETE は拒否', mdDenied.granted === false && mdDenied.detail.includes('permission denied'));
const rfK = k.reflectRequest(ms.graph, pidK, 'precision', 'switch backend');
check('SYSCALL_REFLECT granted + Reflection ノード', rfK.granted && rfK.graph.nodes.some((n) => n.kind === 'reflection'));
const ucK = k.updateCapability(rfK.graph, pidK, 'math', 0.05, 'math');
check('UPDATE_CAPABILITY granted', ucK.granted);
check('memory は Kernel Space', isKernelNode('memory'));
check('task は User Space', !isKernelNode('task'));

// [16] Namespace / Virtual Memory（Process Isolation）
console.log('\n[16] Namespace / Virtual Memory');
let gn = rtK.graph;
const nsA = createNamespace(gn, 'spaceA');
gn = nsA.graph;
const nsB = createNamespace(gn, 'spaceB');
gn = nsB.graph;
gn = assignNamespace(gn, pidK, nsA.id).graph;

// gn 内に第2プロセスを Kernel 経由で生成（SYSCALL_SPAWN）
const taskK = gn.nodes.find((n) => n.kind === 'task')?.id ?? 0;
const spawnRes = k.spawnRequest(gn, taskK, 'code', 0.7);
gn = spawnRes.graph;
const pidP2 = spawnRes.value as number;
gn = assignNamespace(gn, pidP2, nsB.id).graph;

gn = k.memoryStore(gn, pidK, 'secretA', 1, 'spaceA').graph;
gn = k.memoryStore(gn, pidP2, 'secretB', 2, 'spaceB').graph;

check('spaceA の記憶は processA から可読', canAccessMemory(gn, pidK, 'secretA') === true);
check('spaceA の記憶は processB から不可読（Isolation）', canAccessMemory(gn, pidP2, 'secretA') === false);
check('spaceB の記憶は processB から可読', canAccessMemory(gn, pidP2, 'secretB') === true);
const pages = pageMemory(gn);
check('Memory Page 分割', pages.length >= 1);
const page1 = loadPage(pages, 1);
check('LOAD PAGE 1 でエントリ取得', page1 !== undefined && page1.entries.length >= 1);

// [17] AI Program（AILSM で直接プログラムを書く）
console.log('\n[17] AI Program');
const prog = new AiProgram('solve-and-verify')
  .plan('solve x^2-4=0')
  .call('math', 'x^2-4=0')
  .math(MathOpcode.EQ, 'x^2-4=0')
  .verify()
  .reflect('precision', 'retry fp64')
  .call('math', 'x^2-4=0')
  .returns('x=2');
const progInstrs = prog.assemble();
check('AI Program が AILSA 命令列を生成', progInstrs.length >= 5, `len=${progInstrs.length}`);
check('CALL が含まれる', progInstrs.some((i) => i.opcode === Opcode.CALL));
check('SYSCALL_REFLECT が含まれる', progInstrs.some((i) => i.opcode === SyscallOpcode.REFLECT));
check('AI Program がエンコード可能（検証込み）', prog.encode().length > 0);

// [18] AILSM Optimizer（命令レベル: DCE + CALLバッチ化）
console.log('\n[18] AILSM Optimizer');
// ユーザーの例どおり: CALL Math ×3（連続）→ CALL Math Batch=3
const raw: Instruction[] = [
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: '0' }] },
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: '1' }] },
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: '2' }] },
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '2' }] },
];
const opt = optimizeInstructions(raw);
check('CALL 3→1 にバッチ化', opt.stats.callsBefore === 3 && opt.stats.callsAfter === 1, `calls=${opt.stats.callsBefore}->${opt.stats.callsAfter}`);
check('Latency 削減', opt.stats.latencyMsAfter < opt.stats.latencyMsBefore);
check('Cost 削減', opt.stats.costAfter < opt.stats.costBefore);
check('BATCH ノート', opt.notes.some((n) => n.includes('BATCH')));

// [19] AI Linker（複数 Expert → Executable Task）
console.log('\n[19] AI Linker');
const linked = link('pipeline', [
  { name: 'math', expert: 'math', instructions: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'x^2-4=0' }] }] },
  { name: 'search', expert: 'search', instructions: [{ opcode: Opcode.SEARCH, slots: [{ slot: Slot.INPUT, value: 'similar' }] }] },
]);
check('リンクで 2 セグメント', linked.segments.length === 2);
check('シンボルテーブル（math=task0）', linked.segments[0].taskId === '0');
check('CALL×2 + RETURN×2 でラップ', linked.instructions.filter((i) => i.opcode === Opcode.CALL).length === 2 && linked.instructions.filter((i) => i.opcode === Opcode.RETURN).length === 2);
check('リンク後エンコード可能（検証込み）', linked.bytes.length > 0);

// [20] AI ABI（引数/戻り値/エラー/バージョン交渉）
console.log('\n[20] AI ABI');
const arg: AbiArgument = { index: 0, type: 'float32', shape: [1], ownership: 'borrow', alignment: 4 };
check('ABI 引数（float32/borrow/4byte）', arg.type === 'float32' && arg.ownership === 'borrow' && arg.alignment === 4);
check('ABI バージョン整合（1.0 → 1.0）', supportsAbi(ABI_VERSION_1_0, ABI_VERSION_1_0) === true);
check('ABI 不整合（kernel 1.0 → expert 1.1）', supportsAbi({ major: 1, minor: 0 }, { major: 1, minor: 1 }) === false);

// [21] Expert Driver（Kernel → Driver → LLM）
console.log('\n[21] Expert Driver');
const mathDriver = new MockExpertDriver('math', 'Math Expert');
const dResp = mathDriver.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: '2+3' }] }], abiVersion: ABI_VERSION_1_0 });
check('Math Driver: EQ(2+3)=5', dResp.ok && dResp.result === 5, String(dResp.result));
const dErr = mathDriver.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: '1/0' }] }], abiVersion: ABI_VERSION_1_0 });
check('Math Driver: 0除算 → Error ABI', !dErr.ok && dErr.error?.code === 1001 && dErr.error?.retryable === true);
const dAbi = mathDriver.invoke({ program: [], abiVersion: { major: 1, minor: 1 } });
check('ABI 不一致 → UNSUPPORTED_ABI', !dAbi.ok && dAbi.error?.code === 2002);

// [22] AI Device Tree
console.log('\n[22] AI Device Tree');
const dtree = new DeviceTree();
dtree.registerNode({ id: 'pc1', arch: 'x86_64', cpu: 'M3', ramMB: 16384, language: 'ja', cost: 0.1 });
dtree.registerNode({ id: 'iphone', arch: 'arm64', cpu: 'A18', ramMB: 8192, battery: 75, network: true, language: 'ja', cost: 0.05 });
check('DeviceTree ノード登録', dtree.list().length === 2);
check('DeviceTree describe に gpu/battery 情報', dtree.describe().includes('pc1') && dtree.describe().includes('battery=75%'));

// [23] Local Expert Runtime（1台のPCで2 Expert が AILSA で通信）
console.log('\n[23] Local Expert Runtime');
const booted = boot();
check('Driver 11種登録（専門Expert + general）', booted.drivers.size === 11);
const ex1 = await runtimeExecute('x^2を積分して', booted);
check('積分 → math Driver へ委譲', ex1.driverId === 'math', String(ex1.driverId));
check('Driver 結果が返る', typeof ex1.result === 'string' && (ex1.result as string).includes('∫'));
check('結果が Kernel 経由で Memory 保存', ex1.finalGraph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'result'));
check('プロセス finished', ex1.finalGraph.nodes.some((n) => n.kind === 'process' && n.attrs.state === 'finished'));
const ex2 = await runtimeExecute('Webで記事を検索して', booted);
check('検索 → search Driver へ委譲', ex2.driverId === 'search', String(ex2.driverId));
check('search 結果 [doc1..]', ex2.result === '[doc1, doc2, doc3]', String(ex2.result));
const ex3 = await runtimeExecute('2と3を足して', booted);
check('ローカル解決は Driver 不要（result=5）', ex3.driverId === null && ex3.result === null);

// [24] Context SSA（長文・PDF・コードを表すノード）
console.log('\n[24] Context SSA');
const text24 = '0123456789abcdef'; // 16 文字
const pages24 = splitContext(text24, 8);
check('splitContext で 2 ページに分割', pages24.length === 2 && pages24[0] === '01234567' && pages24[1] === '89abcdef');
const ctx24 = createContext({ nodes: [], edges: [] }, '論文', text24, 8);
const cObj24 = contextOf(ctx24.graph, ctx24.contextId);
check('Context#N ノードが作成される', cObj24 !== undefined && cObj24.title === '論文' && cObj24.pageCount === 2);
check('Context contains Page エッジ ×2', ctx24.graph.edges.filter((e) => e.rel === 'contains').length === 2);
check('Page ノードが 2 つ', ctx24.graph.nodes.filter((n) => n.kind === 'page').length === 2);

// [25] Page Manager（固定サイズページの分割・ロード）
console.log('\n[25] Page Manager');
const allPages25 = pagesOf(ctx24.graph, ctx24.contextId);
check('pagesOf が index 順に列挙', allPages25.length === 2 && allPages25[0].index === 0 && allPages25[1].index === 1);
check('ページ実体は offset どおり', allPages25[0].text === '01234567' && allPages25[1].text === '89abcdef');
const loaded25 = loadContextPage(ctx24.graph, allPages25[1].id);
check('loadPage でページをロード（参照操作）', loaded25 !== undefined && loaded25.text === '89abcdef');

// [26] Slice Loader（Expert ごとに必要なページだけをロード）
console.log('\n[26] Slice Loader');
const ct26 = createContext({ nodes: [], edges: [] }, 'doc', 'x^2+2x+1=0 を解け', 64);
check('hasEquation で数式ページを判定', hasEquation('x^2+2x+1=0 を解け'));
const mathSlice26 = selectPages(ct26.graph, ct26.contextId, 'math');
check('Math Expert は数式ページだけを読む', mathSlice26.pageIds.length === 1);
const searchSlice26 = selectPages(ct26.graph, ct26.contextId, 'search');
check('Search Expert は検索語なしページを読まない', searchSlice26.pageIds.length === 0);
check('Slice#N ノード（uses エッジ）', mathSlice26.graph.nodes.some((n) => n.kind === 'slice' && n.attrs.expert === 'math'));

// [27] Context Cache（解析済み Context の再利用）
console.log('\n[27] Context Cache');
const ctx27 = createContext({ nodes: [], edges: [] }, 'c', 'text', 64);
const cid27 = ctx27.contextId;
const c1 = cacheArtifact(ctx27.graph, cid27, 'equation', 'parsed', 'x=-1');
check('初回キャッシュは miss', c1.hit === false);
check('キャッシュ参照で値を取得', getCached(c1.graph, cid27, 'equation', 'parsed') === 'x=-1');
const c2 = cacheArtifact(c1.graph, cid27, 'equation', 'parsed', 'x=-1');
check('2回目は hit（再解析不要）', c2.hit === true);
check('Cache#N ノード（context contains cache）', c1.graph.nodes.some((n) => n.kind === 'cache' && n.attrs.kind === 'equation'));

// [28] AI Virtual Memory デモ（3 Expert が巨大知識の一部だけを読む）
console.log('\n[28] AI Virtual Memory');
const demo = runAvmDemo();
const demoCtx = contextOf(demo.graph, demo.contextId);
check('長文 Context がページ分割される', (demoCtx?.pageCount ?? 0) >= 5);
for (const r of demo.results) {
  check(`${r.expert} は全ページを読まない（${r.stats.loadedPages}/${r.stats.totalPages}）`, r.stats.loadedPages < r.stats.totalPages);
  check(`${r.expert} の供給割合 < 100%（${(r.stats.loadedRatio * 100).toFixed(0)}%）`, r.stats.loadedRatio < 1);
}
const mathR = demo.results[0];
check('Long Context ABI: type=context（参照）', mathR.slice.argument.type === 'context' && mathR.slice.argument.ownership === 'borrow');
check('ContextRef は実体ではなく ID 参照', mathR.slice.ref.contextId === demo.contextId && mathR.slice.ref.pageIds.length === mathR.slice.pageIds.length);
const mathPages = pagesOf(demo.graph, demo.contextId).filter((p) => mathR.slice.pageIds.includes(p.id));
check('Math スライスの各ページは数式を含む', mathPages.length > 0 && mathPages.every((p) => hasEquation(p.text)));
const second = requestSlice(demo.graph, demo.contextId, 'math');
check('再スライスで同一ページを参照', second.load.pageIds.length === mathR.slice.pageIds.length);
const re = cacheResult(demo.graph, demo.contextId, 'summary', 'overview', 'x');
check('Context Cache が再解析を防ぐ（hit）', re.hit === true && re.value !== null);
const abiArg = buildContextArgument(0, { contextId: demo.contextId, pageIds: mathR.slice.pageIds });
check('buildContextArgument が context ABI 引数を作る', abiArg.type === 'context' && abiArg.ownership === 'borrow' && abiArg.alignment === 8);
const ctx28 = storeContext({ nodes: [], edges: [] }, 'k', 'k1 k2 k3');
check('storeContext で Context Object を管理', ctx28.context.title === 'k' && ctx28.context.pageCount >= 1);

// [29] Execution Context SSA（思考途中を保存するプロセスコンテキスト）
console.log('\n[29] Execution Context SSA');
const ectx = createContext({ nodes: [], edges: [] }, 'ec', '0123456789abcdef', 8);
const ex29 = createExecutionContext(ectx.graph, ectx.contextId, 'proc1', 'planning');
check('Execution#N が作成される', ex29.exec.id > 0);
check('初期状態 created / expert=planning', ex29.exec.state === 'created' && ex29.exec.expert === 'planning');
check('context contains execution エッジ', ex29.graph.edges.some((e) => e.rel === 'contains' && e.to === ex29.exec.id));
const up29 = updateExecution(ex29.graph, ex29.exec.id, {
  hypothesis: 'A: 概要を確認した',
  currentPage: 2,
  vars: ['tmp=1'],
  residentPages: [1, 2],
});
check('仮説・現在ページ・一時変数を更新', up29.exec.hypothesis === 'A: 概要を確認した' && up29.exec.currentPage === 2 && up29.exec.vars.length === 1);
check('resident set にページ追加', up29.exec.residentPages.length === 2);
check('Execution ノードが重複しない', up29.graph.nodes.filter((n) => n.kind === 'execution').length === 1);

// [30] Context Switch（save/restore — AI Thread が本物の Thread になる）
console.log('\n[30] Context Switch');
const saved30 = saveExecutionContext(up29.graph, ex29.exec.id);
check('save で suspend（思考途中を保存）', saved30.exec.state === 'suspended' && saved30.exec.hypothesis === 'A: 概要を確認した');
const restored30 = restoreExecutionContext(saved30.graph, ex29.exec.id);
check('restore で running（思考途中を復元）', restored30.exec.state === 'running' && restored30.exec.hypothesis === 'A: 概要を確認した');
const math30 = createExecutionContext(restored30.graph, ectx.contextId, 'proc1', 'math');
const sw30 = contextSwitch(math30.graph, ex29.exec.id, math30.exec.id);
check('Context Switch で planning→math', sw30.events.some((e) => e.kind === 'SWITCH' && e.from === 'planning' && e.to === 'math'));
check('switch 後 math は running / planning は suspended', executionOf(sw30.graph, math30.exec.id)?.state === 'running' && executionOf(sw30.graph, ex29.exec.id)?.state === 'suspended');

// [31] Demand Paging（必要になったページだけをロード）
console.log('\n[31] Demand Paging');
const dp31 = createContext({ nodes: [], edges: [] }, 'dp', 'aaa\nx^2+2x+1=0\nbbb', 40);
const dpPages = pagesOf(dp31.graph, dp31.contextId);
const ex31 = createExecutionContext(dp31.graph, dp31.contextId, 'proc1', 'math');
check('初期は resident 0 ページ', ex31.exec.residentPages.length === 0);
const f31a = contextFault(ex31.graph, ex31.exec.id, dpPages[0].id);
check('未ロードページ → Context Fault 発生', f31a.faulted === true);
check('Fault 後 resident に追加・current page 更新', f31a.exec.residentPages.includes(dpPages[0].id) && f31a.exec.currentPage === dpPages[0].id);
const f31b = contextFault(f31a.graph, ex31.exec.id, dpPages[0].id);
check('ロード済みページ → フォールトなし', f31b.faulted === false && f31b.resident === true);

// [32] Context Fault（Kernel がページ実体をロード）
console.log('\n[32] Context Fault');
// 3 ページ構成: 通常ページ / 数式ページ / 通常ページ（各 10 文字でページ境界を揃える）
const ctx32 = createContext({ nodes: [], edges: [] }, 'fault', 'aaaaaaaaaax^2+2x+1=0bbbbbbbbbb', 10);
const p32 = pagesOf(ctx32.graph, ctx32.contextId);
check('テスト用に 3 ページ', p32.length === 3);
const ex32 = createExecutionContext(ctx32.graph, ctx32.contextId, 'proc1', 'math');
const f0 = contextFault(ex32.graph, ex32.exec.id, p32[0].id); // 通常ページを先にロード
const eq32 = p32.find((p) => hasEquation(p.text));
const f32 = eq32 && eq32.id !== p32[0].id ? contextFault(f0.graph, ex32.exec.id, eq32.id) : null;
check('数式ページを Fault で Kernel がロード', f32 !== null && f32.faulted === true && f32.loaded.includes('x^2+2x+1=0'));
check('Fault でロード済み判定', f32 !== null && isResident(f32.exec, eq32!.id));

// [33] Prefetcher + Execution Context デモ
console.log('\n[33] Prefetcher / Execution Context デモ');
const pf33 = f32 ? prefetch(f32.graph, ex32.exec.id, 1) : null;
check('Prefetch で隣接ページを先読み', pf33 !== null && pf33.prefetched.length > 0 && pf33.prefetched.includes(p32[2].id));
const edemo = runExecutionDemo();
check('デモ: Context Fault が発生', edemo.faults > 0);
check('デモ: Context Switch が発生', edemo.switches > 0);
check('デモ: Prefetch が発生', edemo.prefetched > 0);
check('デモ: 仮説が A → B に更新（思考途中を維持）', edemo.finalHypothesis === 'B: 数式も確認した（x=-1）', edemo.finalHypothesis);
check('デモ: planner は suspended から復帰して running', edemo.planner.state === 'running');
check('デモ: 最終仮説が Memory へ保存', edemo.graph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'final_hypothesis' && String(n.attrs.value).includes('B:')));
const eqPage33 = pagesOf(edemo.graph, edemo.contextId).find((p) => hasEquation(p.text));
check('デモ: math は数式ページを resident に持つ', eqPage33 !== undefined && edemo.math.residentPages.includes(eqPage33.id));
const mem33 = commitMemory(edemo.graph, edemo.planner.id, 'note', 'done');
check('commitMemory で execution stores memory', mem33.graph.edges.some((e) => e.rel === 'stores' && e.from === edemo.planner.id));

// [34] Context Chunk / Span 階層（ページより細かい単位）
console.log('\n[34] Chunk / Span 階層');
const chunks34 = splitChunks('段落1。\n段落2。\n段落3。');
check('splitChunks で段落分割', chunks34.length === 3 && chunks34[0].includes('段落1'));
const spans34 = splitSpans('一文目。二文目。三文目。');
check('splitSpans で文分割', spans34.length === 3 && spans34[1].includes('二文目'));
check('spanKindOf で数式を判定', spanKindOf('x^2+2x+1=0 を解く') === 'equation');
const sub34 = subdivideContext(createContext({ nodes: [], edges: [] }, 'doc', '一行目。x^2+2x+1=0 を解く。\n二行目。', 40).graph, 1);
check('subdivide で Chunk/Span ノード生成', sub34.chunkIds.length >= 1 && sub34.spanIds.length >= 2);
check('span に kind 分類（equation）', sub34.graph.nodes.some((n) => n.kind === 'span' && n.attrs.kind === 'equation'));
check('page contains chunk contains span', sub34.graph.edges.some((e) => e.rel === 'contains'));

// [35] Execution Cursor / Attention（途中再開可能）
console.log('\n[35] Execution Cursor / Attention');
const c35 = createContext({ nodes: [], edges: [] }, 'c', '0123456789', 8);
const ex35 = createExecutionContext(c35.graph, c35.contextId, 'proc1', 'math');
const up35 = updateExecution(ex35.graph, ex35.exec.id, {
  currentPage: 2,
  currentChunk: 1,
  currentSpan: 3,
  cursor: 391,
  attention: ['Equation#5', 'Page#17'],
});
check('Cursor / Chunk / Span を設定', up35.exec.cursor === 391 && up35.exec.currentChunk === 1 && up35.exec.currentSpan === 3);
check('Attention を保持', up35.exec.attention.length === 2 && up35.exec.attention[0] === 'Equation#5');
const search35 = createExecutionContext(up35.graph, c35.contextId, 'proc1', 'search');
const sw35 = contextSwitch(search35.graph, ex35.exec.id, search35.exec.id);
const back35 = contextSwitch(sw35.graph, search35.exec.id, ex35.exec.id);
check('Switch 後も Cursor を復元（途中から再開）', executionOf(back35.graph, ex35.exec.id)?.cursor === 391 && executionOf(back35.graph, ex35.exec.id)?.currentChunk === 1);

// [36] Reasoning Stack / Execution Frames（複数推論の同時進行）
console.log('\n[36] Reasoning Stack');
const ex36 = createExecutionContext(c35.graph, c35.contextId, 'proc1', 'reasoning');
const fa = pushFrame(ex36.graph, ex36.exec.id, 'branchA', 'x=2 の可能性');
const fb = pushFrame(fa.graph, ex36.exec.id, 'branchB', 'x=-1 の可能性');
check('branchA / branchB を push', executionOf(fb.graph, ex36.exec.id)?.stack.length === 2);
check('Frame ノードが生成される', fb.graph.nodes.filter((n) => n.kind === 'frame').length === 2);
const popped = popFrame(fb.graph, ex36.exec.id);
check('popFrame で最上位を除去', executionOf(popped.graph, ex36.exec.id)?.stack.length === 1 && frameOf(popped.graph, fb.frame.id)?.state === 'popped');
const pushedAgain = pushFrame(popped.graph, ex36.exec.id, 'branchB2', 'x=-1 の可能性');
const merged36 = mergeFrames(pushedAgain.graph, ex36.exec.id, 'x=-1 が正しい');
check('mergeFrames で仮説統合・スタッククリア', executionOf(merged36.graph, ex36.exec.id)?.hypothesis === 'x=-1 が正しい' && executionOf(merged36.graph, ex36.exec.id)?.stack.length === 0);
check('merge 後フレームは merged', merged36.graph.nodes.filter((n) => n.kind === 'frame' && n.attrs.state === 'merged').length >= 2);

// [37] Context TLB（Context Translation Cache — 2回目は Fault しない）
console.log('\n[37] Context TLB');
const t37 = createContext({ nodes: [], edges: [] }, 'tlb', 'text\nx^2+2x+1=0 を解く。\ntext2', 40);
const sub37 = subdivideContext(t37.graph, t37.contextId);
const page37 = pagesOf(sub37.graph, t37.contextId)[0];
const tlb37 = new ContextTlb();
const tr1 = translateSpan(tlb37, sub37.graph, t37.contextId, page37.id, 'equation');
check('初回翻訳はミス（走査してキャッシュ）', tr1.hit === false && tr1.spanIds.length >= 1);
const tr2 = translateSpan(tlb37, sub37.graph, t37.contextId, page37.id, 'equation');
check('2回目はヒット（Fault しない）', tr2.hit === true);
check('TLB ヒット率', tlb37.hitRate() >= 0.5);
check('spansOfKind が equation だけ返す', spansOfKind(sub37.graph, page37.id, 'equation').every((s) => s.kind === 'equation'));

// [38] Hot / Warm / Cold Tier + Memory Hierarchy デモ
console.log('\n[38] Memory Tier / Memory Hierarchy デモ');
const tier38 = new TierManager();
check('未アクセスは COLD', tier38.tierOf(1) === 'cold');
tier38.touch(1);
check('1回アクセスで WARM', tier38.tierOf(1) === 'warm');
tier38.touch(1);
tier38.touch(1);
check('3回アクセスで HOT', tier38.tierOf(1) === 'hot');
tier38.touch(2);
check('evictCold が未アクセスを返す', tier38.evictCold().length === 0 && tier38.untrackedPages([1, 2, 3]).includes(3));
const mh = runMemoryHierarchyDemo();
check('Chunk/Span 階層が生成される', mh.chunkCount >= 4 && mh.spanCount > mh.chunkCount);
check('Equation スパンが分類される', mh.equationSpanCount >= 3);
check('TLB: 初回 miss → 2回目 hit', mh.tlbFirst === true && mh.tlbSecond === true && mh.tlbHitRate >= 0.5);
check('Reasoning Stack: branchA/branchB を merge', mh.frameLabels.join(',') === 'branchA,branchB' && mh.mergedHypothesis === 'x=-1 が正しい');
check('Memory Tier: HOT/WARM/COLD が揃う', mh.tiers.hot === 1 && mh.tiers.warm === 1 && mh.tiers.cold >= 1);
check('Cursor/Attention で途中再開可能', mh.cursor === 391 && mh.attention.includes('Equation#5') && mh.currentChunk !== null && mh.currentSpan !== null);

// [44] Remote Driver（実LLM: MockModelClient で検証）
console.log('\n[44] Remote Driver（実LLM接続）');
const rmc = new MockModelClient({ 'x^2を積分して': '∫x² dx = x³/3 + C' });
const rd44 = new RemoteDriver('remote:mock-qwen-1.5b', 'Qwen@mock', rmc, { deviceId: 'mock-qwen-1.5b' });
const rdRes = await rd44.invoke({ program: [{ opcode: MathOpcode.INTEGRAL, slots: [{ slot: Slot.INPUT, value: 'x^2を積分して' }] }], abiVersion: ABI_VERSION_1_0 });
check('RemoteDriver が実LLM相当で応答', rdRes.ok && rdRes.result === '∫x² dx = x³/3 + C');
check('RemoteDriver が使用デバイスを記録', rd44.lastNode?.nodeId === 'mock-qwen-1.5b');
const rdAbi = await rd44.invoke({ program: [], abiVersion: { major: 1, minor: 1 } });
check('RemoteDriver ABI 不整合 → UNSUPPORTED_ABI', !rdAbi.ok && rdAbi.error?.code === 2002);

// [45] Multi-expert AILSA Relay（Expert→Expert 通信）
console.log('\n[45] AILSA Relay');
const booted45 = boot();
const relay45 = await runRelay(booted45, [
  { expert: 'planning', input: '本を要約して' },
  { expert: 'math', input: 'x^2-4=0を解いて' },
  { expert: 'search', input: 'Webで記事を検索して' },
  { expert: 'reasoning', input: '結論をまとめて' },
  { expert: 'planning', input: '本を要約して' },
]);
check('Relay が 5 ホップ（Planner→Math→Search→Reasoning→Planner）', relay45.hops.length === 5);
check('各ホップが AILSA プログラム（hex）を保持', relay45.hops.every((h) => h.ailsaHex.length > 0));
check('AILSA メッセージ一覧', relay45.ailsaMessages.length === 5 && relay45.ailsaMessages[1].includes('CALL math'));
const relay45b = await runRelay(booted45, [
  { expert: 'math', input: 'x^2-4=0を解いて' },
  { expert: 'search', input: '' },
]);
check('Expert→Expert で値が伝播（solution(...) が次の INPUT へ）', relay45b.hops[1].input === 'solution(x^2-4=0)', relay45b.hops[1].input);
check('連鎖ホップは生の AILSA CALL として送られる', relay45b.hops[1].ailsaHex.startsWith('30'), relay45b.hops[1].ailsaHex.slice(0, 4));

// [46] Device Router（Mac / iPhone / iPad へルーティング）
console.log('\n[46] Device Router');
const dt46 = new DeviceTree();
dt46.registerNode({ id: 'local-pc', arch: 'arm64', cpu: 'Apple Silicon', ramMB: 16384, language: 'ja', cost: 0.1 });
registerHubDevices(dt46, [{ nodeId: 'node-ios-iphone15', modelId: 'Qwen/Qwen2.5-1.5B-Instruct', paramsM: 1540 }]);
check('実ノードが DeviceTree に登録', dt46.node('node-ios-iphone15') !== undefined);
check('routeCall が Mac/ローカルを優先', routeCall(dt46) === 'local-pc');
check('routeCall が優先指定を尊重', routeCall(dt46, 'node-ios-iphone15') === 'node-ios-iphone15');
const dr46 = createContext({ nodes: [], edges: [] }, 'dist', '0123456789abcdef', 8);
const pageA46 = pagesOf(dr46.graph, dr46.contextId)[0].id;
const g46 = assignPageDevice(dr46.graph, pageA46, 'node-ios-iphone15');
check('ページをデバイスへ配置（分散Context）', pageDevice(g46, pageA46) === 'node-ios-iphone15');

// [47] 分散 Context Fault（デバイスからページ取得）
console.log('\n[47] 分散 Context Fault');
const client47 = new MockModelClient({});
const df47 = await distributedFault(client47, 'node-ios-iphone15', 'ページ本文: x^2+2x+1=0');
check('分散 Fault が実デバイスから取得', df47.fromDevice === 'node-ios-iphone15' && df47.text.includes('mock') && df47.ms >= 0);

// [48] Capability オンライン学習（ODAR 完成）
console.log('\n[48] Capability オンライン学習');
const learner48 = new CapabilityLearner();
learner48.observe('math', { accuracy: 0.9, latencyMs: 20, cost: 0.2 });
const c48 = learner48.get('math');
check('EMA で能力値を更新（latency が 100→20 方向へ）', c48.samples === 1 && c48.accuracy > 0.5 && c48.latencyMs < 100);
learner48.observe('math', { accuracy: 0.5, latencyMs: 100, cost: 0.8 });
check('2回目の観測で学習が進む', learner48.get('math').samples === 2 && learner48.get('math').accuracy < c48.accuracy);
learner48.observe('search', { accuracy: 0.3, latencyMs: 200, cost: 0.9 });
check('Learning Scheduler が学習値で math を選ぶ', learner48.pick(['math', 'search']) === 'math');
const b48 = new AilsmBuilder();
const task48 = b48.addNode('task', 'solve', 'unknown', {});
const g48 = b48.graph();
const upd48 = updateCapabilitySsa(g48, task48, 'math', { accuracy: 0.9, latencyMs: 25, cost: 0.2 });
check('Capability SSA に学習値を反映', upd48.graph.nodes.some((n) => n.kind === 'capability' && n.attrs.expert === 'math' && n.attrs.accuracy === 0.9));
const upd48b = updateCapabilitySsa(upd48.graph, task48, 'math', { accuracy: 0.8, latencyMs: 30, cost: 0.3 });
check('Capability ノードを in-place 更新（重複しない）', upd48b.graph.nodes.filter((n) => n.kind === 'capability').length === 1 && upd48b.graph.nodes.some((n) => n.attrs.learned === true));

// [49] AI OS Init（Hub = AI OS 本体）
console.log('\n[49] AI OS Init');
const aios49 = initAiOs();
check('AI OS 起動（mock デバイス 2 台 + RemoteDriver）', aios49.remoteDrivers.size === 2 && aios49.booted.deviceTree.list().length >= 3);
const aex49 = await aiosExecute(aios49, '2と3を足して');
check('ローカル解決はドライバ不要（デバイスは割当済み）', aex49.driverId === null && aex49.result === null && aex49.deviceId !== null);
const aex49b = await aiosExecute(aios49, 'x^2を積分して');
check('CALL → 実デバイス（RemoteDriver）へ委譲', aex49b.driverId?.includes('remote:') === true && aex49b.deviceId !== null && aex49b.result !== null);
check('ODAR が実実行の観測を学習', aios49.learner.get(String(aex49b.driverId)).samples >= 1);
const rel49 = await aiosRelay(aios49, [{ expert: 'math', input: 'x^2-4=0を解いて' }, { expert: 'math', input: '' }]);
check('AI OS でリレー実行', rel49.hops.length === 2 && rel49.hops[1].input === 'solution(x^2-4=0)');
// 遅延同期: 起動後に実機が接続されても委譲できる（Hub 再起動シナリオ）
const lateClient = new MockModelClient({}, []);
const aiosLate = initAiOs(lateClient);
check('起動時はデバイス 0 台（RemoteDriver なし）', aiosLate.remoteDrivers.size === 0);
lateClient.addNode({ nodeId: 'node-ios-iphone15', modelId: 'Qwen/Qwen2.5-1.5B-Instruct', paramsM: 1540 });
const aexLate = await aiosExecute(aiosLate, 'x^2を積分して');
check('起動後に接続した実機へ遅延委譲', aexLate.driverId === 'remote:node-ios-iphone15' && aexLate.deviceId === 'node-ios-iphone15', String(aexLate.driverId));
check('DeviceTree に遅延登録', aiosLate.booted.deviceTree.node('node-ios-iphone15') !== undefined);

// [50] 専門 Expert 10 種（Phase 3.0）
console.log('\n[50] Expert 10 種');
const booted50 = boot();
check('11 種のドライバが登録', booted50.drivers.size === 11);
const prog50 = await booted50.drivers.get('programming')!.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'sort array' }] }], abiVersion: ABI_VERSION_1_0 });
check('programming Expert が応答', prog50.ok && String(prog50.result).includes('code'));
const tr50 = await booted50.drivers.get('translate')!.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'こんにちは' }] }], abiVersion: ABI_VERSION_1_0 });
check('translate Expert が応答', tr50.ok && String(tr50.result).includes('translate'));
const mem50 = await booted50.drivers.get('memory')!.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: '覚えておいて' }] }], abiVersion: ABI_VERSION_1_0 });
check('memory Expert が応答', mem50.ok && String(mem50.result).includes('保存'));

// [51] 方式比較ベンチマーク（論文 Table）
console.log('\n[51] 方式比較');
const cmp51 = runComparisonBenchmark();
check('比較表に 7 行（6 方式 + ArcAsha）', cmp51.rows.length === 7);
const arc51 = cmp51.rows.find((r) => r.method.includes('Ours'))!;
const qwen51 = cmp51.rows.find((r) => r.method.includes('Long Context'))!;
const rag51 = cmp51.rows.find((r) => r.method.includes('RAG'))!;
check('ArcAsha の読むトークン < Qwen 全読', arc51.readTokens < qwen51.readTokens, `${arc51.readTokens} < ${qwen51.readTokens}`);
check('ArcAsha の Latency < Qwen Long Context', arc51.latencyMs < qwen51.latencyMs, `${arc51.latencyMs} < ${qwen51.latencyMs}`);
check('ArcAsha は RAG より高精度', arc51.accuracy > rag51.accuracy, `${arc51.accuracy} > ${rag51.accuracy}`);
check('比較表が Markdown で描画', cmp51.table.includes('| 方式 |') && cmp51.table.includes('ArcAsha AVM'));

// [52] Fault スケーリング実験（100 / 500 / 1000 ページ）
console.log('\n[52] Fault スケーリング');
const scale52 = runScalingExperiment([100, 500, 1000]);
check('3 レベルで実験', scale52.length === 3);
check('全レベルで Token 削減 > 50%', scale52.every((r) => r.tokenReduction > 50));
check('全レベルで Speedup > 1', scale52.every((r) => r.speedup > 1));
check('ページ増加で Fault 率が収束（≤60%）', scale52.every((r) => r.faultRate <= 60));
check('スケーリング表が描画', renderScaling(scale52).includes('| Pages |'));

// [53] ODAR マルチシグナル学習（success / battery / gpu）
console.log('\n[53] ODAR マルチシグナル');
const learner53 = new CapabilityLearner();
learner53.observe('math', { accuracy: 0.9, latencyMs: 20, cost: 0.2, success: true, battery: 0.8, gpu: 0.9 });
const c53 = learner53.get('math');
check('success/battery/gpu を EMA 学習', c53.successRate > 0.5 && c53.avgBattery > 0.5 && c53.avgGpu > 0.5);
learner53.observe('math', { accuracy: 0.9, latencyMs: 20, cost: 0.2, success: true, battery: 0.9, gpu: 0.2 });
check('2回目で学習が進む', learner53.get('math').samples === 2 && learner53.get('math').avgGpu < c53.avgGpu);
const l53x = new CapabilityLearner();
l53x.observe('a', { accuracy: 0.9, latencyMs: 30, cost: 0.2, success: true, battery: 0.9 });
l53x.observe('b', { accuracy: 0.9, latencyMs: 30, cost: 0.2, success: true, battery: 0.3 });
check('残量が多い Expert を学習で選ぶ', l53x.score('a') > l53x.score('b'));

// [54] 10 Expert リレー（Planner→Search→Math→Reasoning→Programming→Translate→Planner）
console.log('\n[54] 10 Expert リレー');
const relay54 = await runRelay(booted50, [
  { expert: 'planning', input: '本を要約して' },
  { expert: 'search', input: 'Webで記事を検索して' },
  { expert: 'math', input: 'x^2-4=0を解いて' },
  { expert: 'reasoning', input: '結論をまとめて' },
  { expert: 'programming', input: 'sort array' },
  { expert: 'translate', input: 'こんにちは' },
  { expert: 'planning', input: '本を要約して' },
]);
check('7 ホップがすべて成功', relay54.hops.length === 7 && relay54.hops.every((h) => h.ok));
check('AILSA メッセージが各ホップに', relay54.ailsaMessages.length === 7 && relay54.ailsaMessages[4].includes('CALL programming'));

// [55] 「作って」系意図 + Stage-2 フォールバック（既存AIのタスクを全部任せられる）
console.log('\n[55] create 意図 / Stage-2 フォールバック');
const c55 = compile('ログイン機能を作って');
check('「作って」→ intent=create / domain=code', c55.normalized.intent === 'create' && c55.normalized.domain === 'code');
check('「作って」→ programming へ CALL', c55.capability.expert === 'programming', c55.capability.expert);
check('「作って」のタスク文が INPUT に載る', c55.instructions.some((i) => i.slots?.some((s) => s.slot === Slot.INPUT && String(s.value).includes('ログイン'))));
const c55b = compile('Todoアプリを実装して');
check('「実装して」→ create', c55b.normalized.intent === 'create');
const c55c = compile('ゲームを作ろう');
check('「作ろう」→ create', c55c.normalized.intent === 'create');
const aios55 = initAiOs();
const cr55 = await aiosExecute(aios55, 'ログイン機能を作って');
check('「作って」→ 実デバイス(mock)へ委譲', cr55.driverId?.includes('remote:') === true && cr55.result !== null, String(cr55.driverId));
const fb55 = await aiosExecute(aios55, '量子コンピュータについて説明してください');
check('解釈不能タスクもフォールバックで委譲（400にしない）', fb55.fallback === true && fb55.driverId !== null && fb55.result !== null, String(fb55.driverId));
check('フォールバックの AILSA は生 CALL', (fb55.compile as { instructions: unknown[] }).instructions.length === 1);
check('フォールバックでも ODAR 学習', aios55.learner.get(String(fb55.driverId)).samples >= 1);

// [56] Hypothesis SSA（仮説の生成・評価・採用・淘汰・統合）
console.log('\n[56] Hypothesis SSA');
const b56 = new AilsmBuilder();
const t56 = b56.addNode('task', 'solve', 'unknown', { domain: 'math', intent: 'solve' });
let g56 = b56.graph();
const h1 = hypothesize(g56, t56, 'x=3 が解', 0.5);
g56 = h1.graph;
check('hypothesize で Hypothesis#N 生成', hypothesisOf(g56, h1.id)?.state === 'proposed' && hypothesisOf(g56, h1.id)?.confidence === 0.5);
check('task hypothesizes hypothesis エッジ', g56.edges.some((e) => e.rel === 'hypothesizes'));
g56 = activate(g56, h1.id, 'math').graph;
g56 = evaluate(g56, h1.id, 0.8).graph;
check('activate/evaluate で active + score', hypothesisOf(g56, h1.id)?.state === 'active' && hypothesisOf(g56, h1.id)?.score === 0.8);
g56 = accept(g56, h1.id).graph;
check('accept で accepted', hypothesisOf(g56, h1.id)?.state === 'accepted');
const h2 = hypothesize(g56, t56, 'x=-3 が解', 0.5);
g56 = h2.graph;
const m56 = merge(g56, t56, [h1.id, h2.id], 'x=±3', 0.9);
g56 = m56.graph;
check('merge で元は merged / 新仮説生成', hypothesisOf(g56, h1.id)?.state === 'merged' && hypothesisOf(g56, m56.id)?.text === 'x=±3' && hypothesisOf(g56, m56.id)?.parentIds.length === 2);
check('hypothesesOf で列挙', hypothesesOf(g56, t56).length === 3);

// [57] Reasoning Runtime デモ（x^2=9: SPAWN→EVAL→MERGE/KILL）
console.log('\n[57] Reasoning Runtime');
const demo57 = await runReasoningDemo();
check('デモ: 最終仮説 x=±3', demo57.finalText === 'x=±3', String(demo57.finalText));
check('デモ: 3 仮説を評価', demo57.rounds[0].evaluated.length === 3);
check('デモ: 低評価 H3 は KILL（淘汰）', demo57.rounds[0].killed.length === 1);
check('デモ: H1+H2 を MERGE', demo57.rounds[0].merged.length === 1 && demo57.rounds[0].merged[0].text === 'x=±3');
check('デモ: 各仮説が独立 Process（OS 並列）', demo57.processes >= 3);
check('デモ: Expert 呼び出しあり', demo57.expertCalls >= 3);

// [58] 汎用 Reasoning（既定の仮説生成 + 循環）
console.log('\n[58] 汎用 Reasoning');
const booted58 = boot();
const r58 = await runReasoning('新しい数学を考えて', booted58);
check('汎用: 仮説が生成される', r58.rounds.length >= 1 && r58.rounds[0].spawned.length >= 3);
check('汎用: Hypothesis ノードが SSA に', r58.graph.nodes.some((n) => n.kind === 'hypothesis'));
check('汎用: Expert 呼び出し / Process 生成', r58.expertCalls >= 3 && r58.processes >= 3);
check('汎用: 既定生成がドメイン別（math）', defaultHypothesisGenerator('x^2=9を解く')[0].expert === 'math' && defaultHypothesisGenerator('アプリを作って')[0].expert === 'programming');
check('汎用: 収束 or 全ラウンド完了', r58.finalText !== null || r58.rounds.every((rd) => rd.accepted.length === 0));

// [59] Reasoning Tree（EXPAND / 子仮説 / depth / expands エッジ）
console.log('\n[59] Reasoning Tree');
const b59 = new AilsmBuilder();
const t59 = b59.addNode('task', 'reason', 'unknown', { domain: 'reasoning', intent: 'unknown' });
let g59 = b59.graph();
const h59 = hypothesize(g59, t59, '既存の枠組みを疑う', 0.4, 'reasoning');
g59 = h59.graph;
const ex59 = expand(g59, t59, h59.id, [
  { text: '統計的に検証する', confidence: 0.5, expert: 'math' },
  { text: '幾何学的に解釈する', confidence: 0.5, expert: 'math' },
]);
g59 = ex59.graph;
check('EXPAND で子仮説が生成される', ex59.ids.length === 2);
check('expands エッジ（Reasoning Tree）', g59.edges.some((e) => e.rel === 'expands' && e.from === h59.id));
check('子仮説の depth=1 / parentIds', childrenOf(g59, h59.id).every((c) => c.depth === 1 && c.parentIds.includes(h59.id)));
g59 = markExpanded(g59, h59.id).graph;
check('markExpanded で展開済み', hypothesisOf(g59, h59.id)?.expanded === true);
const ex59b = expand(g59, t59, ex59.ids[1], [{ text: '位相で一般化する', confidence: 0.6, expert: 'reasoning' }]);
g59 = ex59b.graph;
check('深さ2の孫仮説（depth=2）', hypothesisOf(g59, ex59b.ids[0])?.depth === 2);

// [60] Search Policy（探索 vs 活用 / Beam / Best-First / DFS / BFS / MCTS）
console.log('\n[60] Search Policy');
const mkH = (id: number, score: number, novelty: number, depth = 0, cost = 0.1): Hypothesis => ({
  id, text: `H${id}`, confidence: 0.5, state: 'proposed', expert: 'math', score, parentIds: [],
  novelty, diversity: 0.5, cost, consistency: 0.5, visits: 0, depth, expanded: false,
});
const hNovel = mkH(1, 0.5, 0.9);
const hSafe = mkH(2, 0.8, 0.05);
check('explore=0 は高スコア優先（活用）', selectionScore(hSafe, { explore: 0, costPenalty: 0.3 }) > selectionScore(hNovel, { explore: 0, costPenalty: 0.3 }));
check('explore=0.8 は新規性優先（探索）', selectionScore(hNovel, { explore: 0.8, costPenalty: 0.3 }) > selectionScore(hSafe, { explore: 0.8, costPenalty: 0.3 }));
const ready60 = [mkH(1, 0.5, 0.9, 1), mkH(2, 0.8, 0.05, 0), mkH(3, 0.6, 0.6, 2), mkH(4, 0.4, 0.7, 0)];
const w60 = { explore: 0.5, costPenalty: 0.3 };
check('Beam は top-2 を選ぶ', new BeamSearchPolicy().select(ready60, 2, w60).length === 2);
check('Best-First は 1 つ選ぶ', new BestFirstPolicy().select(ready60, 2, w60).length === 1);
check('DFS は深い仮説を優先', new DFSPolicy().select(ready60, 1, w60)[0].depth === 2);
check('BFS は浅い仮説を優先', new BFSPolicy().select(ready60, 1, w60)[0].depth === 0);
const mcts = new MctsPolicy();
const mctsSel = mcts.select(ready60, 1, w60);
check('MCTS が UCB で選択できる', mctsSel.length === 1 && mctsSel[0].id >= 1);

// [61] Reasoning Search Runtime（ループ: EXPAND→EVAL→REFLECT→...）
console.log('\n[61] Reasoning Search Runtime');
const r61 = await runSearchDemo();
check('探索ポリシー = beam', r61.policy === 'beam', r61.policy);
check('Reasoning Tree（depth=2 まで）', r61.tree.some((t) => t.depth === 2));
check('EXPAND ループが回る', r61.expansions >= 2 && r61.evaluations >= 4);
check('新規性で低スコア仮説が生き残る（探索）', r61.acceptedTexts.some((t) => t.includes('統計')), r61.acceptedTexts.join('|'));
check('低新規性仮説は KILL（淘汰）', r61.killedCount === 1);
check('採用仮説を最終 MERGE（統合）', r61.finalText !== null && r61.finalText.includes('統合仮説'), String(r61.finalText));
check('renderSearch がツリー表示', renderSearch(r61).includes('=== Reasoning Search') && renderSearch(r61).includes('FINAL'));

// [62] Executive Runtime（Executive が探索の途中で戦略を切替える）
console.log('\n[62] Executive Runtime');
const b62 = new AilsmBuilder();
const t62 = b62.addNode('task', 'exec', 'unknown', { domain: 'reasoning', intent: 'unknown' });
const ex62 = executive(b62.graph(), t62, '数学の新理論を考える', { policy: 'best-first', beam: 1, experts: ['math'] });
check('Executive がゴールを管理（task manages executive）', ex62.graph.edges.some((e) => e.rel === 'manages' && e.from === t62));
const exec62 = executiveOf(ex62.graph, ex62.id);
check('Executive の初期設定（beam=1 / explore=0.2）', exec62?.beam === 1 && exec62?.explore === 0.2 && exec62?.experts.includes('math') === true);
const up62 = updateExecutive(ex62.graph, ex62.id, { beam: 3, explore: 0.6, switches: 1 });
const exec62b = executiveOf(up62.graph, ex62.id);
check('設定を in-place 更新（ID 不変）', exec62b?.beam === 3 && exec62b?.explore === 0.6 && exec62b?.switches === 1 && exec62b?.id === ex62.id);
check('executivesOf が列挙', executivesOf(up62.graph, t62).length === 1);

const r62 = await runExecutiveDemo();
check('Executive ノードが生成される', r62.executiveId > 0);
check('探索途中の戦略切替（R0: best-first→beam / beam 1→3 / explore 増）', r62.configChanges.length >= 3 && r62.configChanges[0].action.includes('beam') && r62.configChanges[0].action.includes('explore 0.2→0.6'), r62.configChanges.map((c) => c.action).join(' | '));
check('停滞検知（accept=0）で探索へ切替', r62.configChanges[0]?.reason.includes('停滞'), r62.configChanges[0]?.reason ?? '');
check('Expert 追加（+search+reasoning）', r62.configChanges[0]?.action.includes('+search') && r62.configChanges[0]?.action.includes('+reasoning'));
check('弱い Expert を削除（remove search）', r62.configChanges.some((c) => c.action.includes('remove search')));
check('探索で新規性仮説が ACCEPT（低スコア0.55・新規性0.90）', r62.acceptedTexts.some((t) => t.includes('統計')), r62.acceptedTexts.join('|'));
check('低新規性仮説は KILL（淘汰）', r62.killedCount === 1);
check('ラウンド数 ≥ 3（戦略切替が複数回）', r62.rounds.length >= 3, `rounds=${r62.rounds.length}`);
check('最終 MERGE（統合仮説）', r62.finalText !== null && r62.finalText.includes('統合仮説'), String(r62.finalText));
check('renderExecutive がツリー + 戦略切替ログ表示', renderExecutive(r62).includes('=== Executive Runtime') && renderExecutive(r62).includes('EXECUTIVE(R0)'));
check('defaultDecide: 停滞→探索 / 成功→活用', defaultDecide({ round: 0, config: { policy: 'best-first', beam: 1, weights: { explore: 0.2, costPenalty: 0.3 }, temperature: 0.2, experts: ['math'] }, expanded: 1, accepted: 0, killed: 0, pending: 1, totalAccepted: 0, killByExpert: new Map(), expertPool: ['search'] })?.changes.weights?.explore === 0.6);

// [63] Meta Executive（Executive を学習する Executive + Thinking Budget）
console.log('\n[63] Meta Executive');
const b63 = new AilsmBuilder();
const t63 = b63.addNode('task', 'meta', 'unknown', { domain: 'reasoning', intent: 'unknown' });
const me63 = metaExecutive(b63.graph(), t63, '数学の新理論を考える');
check('Meta Executive ノードが生成される', me63.graph.nodes.some((n) => n.kind === 'metaexecutive'));
check('task manages metaexecutive エッジ', me63.graph.edges.some((e) => e.rel === 'manages' && e.from === t63 && me63.graph.nodes.find((n) => n.id === e.to)?.kind === 'metaexecutive'));
const up63 = updateMetaExecutive(me63.graph, me63.id, { policy: 'mcts', beam: 3, explore: 0.6, trials: 2 });
const me63b = metaExecutiveOf(up63.graph, me63.id);
check('設定を in-place 更新（ID 不変）', me63b?.policy === 'mcts' && me63b?.beam === 3 && me63b?.trials === 2 && me63b?.id === me63.id);
check('metaExecutivesOf が列挙', metaExecutivesOf(up63.graph, t63).length === 1);

const b2_63 = estimateBudget('2+2を計算して');
check('Thinking Budget: 2+2 → Reasoning 禁止（trivial）', b2_63.allowReasoning === false && b2_63.reason === 'trivial');
const bHard63 = estimateBudget('新しい数学の理論を考える');
check('Thinking Budget: 新理論 → 大予算（high）', bHard63.allowReasoning === true && bHard63.reason === 'high' && bHard63.maxExpansions >= 8 && bHard63.depth >= 10 && bHard63.experts.length >= 4);
const bBat63 = estimateBudget('新しい数学の理論を考える', { battery: 0.08 });
check('Thinking Budget: Battery 8% → Reasoning 禁止', bBat63.allowReasoning === false && bBat63.reason === 'battery');
const bBat63b = estimateBudget('新しい数学の理論を考える', { battery: 0.2 });
check('Thinking Budget: 低バッテリ → 軽い推論のみ', bBat63b.allowReasoning === true && bBat63b.reason === 'battery-low' && bBat63b.maxExpansions === 2);

const r63 = await runMetaExecutiveDemo();
check('学習ループが回る（3 試行）', r63.trials.length === 3, `trials=${r63.trials.length}`);
check('Search Policy を切替（beam→best-first→mcts）', r63.policySwitches.length >= 2, r63.policySwitches.join(' → '));
check('学習: 探索が強すぎる設定は失敗（beam2/explore0.4 → acc=0）', r63.trials[0].outcome.accuracy === 0 && r63.trials[0].metaScore < 0);
check('学習: 最良設定が推奨される（best-first が ◀ 推奨）', r63.trials.find((t) => t.recommended)?.policy === 'best-first', String(r63.trials.find((t) => t.recommended)?.policy));
check('推奨設定から不要 Expert が外れる（search なし）', r63.recommendedConfig !== null && !r63.recommendedConfig.experts.includes('search'), r63.recommendedConfig?.experts.join(',') ?? '');
check('精度・レイテンシ・コストを計測', r63.trials.every((t) => t.outcome.latencyMs > 0 && t.outcome.cost >= 0));
check('推奨設定で統合仮説に到達', r63.finalText !== null && r63.finalText.includes('統合仮説'), String(r63.finalText));
check('Meta Executive が Executive を管理（manages エッジ）', r63.graph.edges.some((e) => e.rel === 'manages' && r63.graph.nodes.find((n) => n.id === e.from)?.kind === 'metaexecutive' && r63.graph.nodes.find((n) => n.id === e.to)?.kind === 'executive'));
check('renderMetaExecutive が Budget + 学習テーブル表示', renderMetaExecutive(r63).includes('BUDGET') && renderMetaExecutive(r63).includes('◀ 推奨'));

// [64] Expert Evolution（Expert が自分で分裂・統合・引退する）
console.log('\n[64] Expert Evolution');
const b64 = new AilsmBuilder();
const t64 = b64.addNode('task', 'evolve', 'unknown', { domain: 'reasoning', intent: 'unknown' });
const ex64 = expert(b64.graph(), t64, 'math', { accuracy: 0.85, novelty: 0.8, cost: 0.7, utilization: 1.0 });
check('Expert ノード生成（task manages expert）', ex64.graph.nodes.some((n) => n.kind === 'expert') && ex64.graph.edges.some((e) => e.rel === 'manages' && e.from === t64 && ex64.graph.nodes.find((n) => n.id === e.to)?.kind === 'expert'));
const health64 = computeHealth({ expert: 'math', accuracy: 0.85, novelty: 0.8, cost: 0.7, latency: 0.4, confidence: 0.8, memory: 0.3, battery: 0.5, gpu: 0.6, temperature: 0.4, utilization: 1.0, overlap: 0.2 });
check('合成健康度が計算される', health64 > 0 && health64 < 1, health64.toFixed(3));
check('SPLIT 判定（忙しい+高精度+高新規性+高コスト）', shouldSplit({ expert: 'math', accuracy: 0.85, novelty: 0.8, cost: 0.7, latency: 0.4, confidence: 0.8, memory: 0.3, battery: 0.5, gpu: 0.6, temperature: 0.4, utilization: 1.0, overlap: 0.2, health: health64 }) === true);
check('SPLIT 判定（低負荷は false）', shouldSplit({ expert: 'math', accuracy: 0.85, novelty: 0.8, cost: 0.7, latency: 0.4, confidence: 0.8, memory: 0.3, battery: 0.5, gpu: 0.6, temperature: 0.4, utilization: 0.1, overlap: 0.2, health: health64 }) === false);
const hStat64: Parameters<typeof shouldMerge>[0] = { expert: 'statistics', accuracy: 0.6, latency: 0.3, cost: 0.2, novelty: 0.15, confidence: 0.6, memory: 0.2, battery: 0.5, gpu: 0.2, temperature: 0.3, utilization: 0.3, overlap: 0.75, health: 0.32 };
const hAlg64: Parameters<typeof shouldMerge>[1] = { expert: 'algebra', accuracy: 0.7, latency: 0.35, cost: 0.3, novelty: 0.3, confidence: 0.7, memory: 0.25, battery: 0.5, gpu: 0.3, temperature: 0.35, utilization: 0.35, overlap: 0.75, health: 0.39 };
check('MERGE 判定（overlap↑ + 中程度ヘルス）', shouldMerge(hStat64, hAlg64) === true);
check('RETIRE 判定（低ヘルス + 低利用率）', shouldRetire({ expert: 'calc', accuracy: 0.4, latency: 0.4, cost: 0.3, novelty: 0.1, confidence: 0.4, memory: 0.3, battery: 0.6, gpu: 0.4, temperature: 0.5, utilization: 0.05, overlap: 0.4, health: 0.16 }) === true);
const sp64 = splitExpert(ex64.graph, t64, ex64.id, [{ name: 'geometry' }, { name: 'algebra' }, { name: 'calculus' }, { name: 'statistics' }]);
check('SPLIT: math → 4 子 + specializes エッジ', sp64.ids.length === 4 && sp64.graph.edges.filter((e) => e.rel === 'specializes' && e.from === ex64.id).length === 4);
const mg64 = mergeExperts(sp64.graph, t64, sp64.ids.slice(1, 3), 'math-general');
check('MERGE: mergesInto エッジ（統合）', mg64.graph.edges.filter((e) => e.rel === 'mergesInto').length === 2 && expertOf(mg64.graph, mg64.id)?.name === 'math-general');
const rt64 = retireExpert(mg64.graph, sp64.ids[0]);
check('RETIRE: state=retired', expertOf(rt64.graph, sp64.ids[0])?.state === 'retired');
check('expertsOf が列挙', expertsOf(rt64.graph, t64).length >= 6);

const r64 = runExpertEvolutionDemo();
const ops64 = r64.rounds.flatMap((rd) => rd.ops);
check('数学が SPLIT（math → geometry 等 4 種）', ops64.some((o) => o.kind === 'split' && o.source === 'math' && o.children?.includes('geometry')));
check('幾何が SPLIT（geometry → triangle 等）', ops64.some((o) => o.kind === 'split' && o.source === 'geometry' && o.children?.includes('graph')));
check('統計+代数 → math-general（MERGE）', ops64.some((o) => o.kind === 'merge' && o.target === 'math-general'));
check('低ヘルスは引退（calculus RETIRE）', ops64.some((o) => o.kind === 'retire' && o.source === 'calculus'));
check('グラフが SPLIT（graph → bfs/dfs/shortestpath/flow）', ops64.some((o) => o.kind === 'split' && o.source === 'graph' && o.children?.includes('bfs') && o.children?.includes('flow')));
check('進化後のプールに専門化先が含まれる', ['bfs', 'dfs', 'shortestpath', 'flow', 'triangle', 'math-general'].every((n) => r64.finalPool.includes(n)), r64.finalPool.join(','));
check('客観的理由が数値で説明される', ops64.every((o) => /util=|overlap=|health=/.test(o.reason)));
check('Expert Health が記録される', Object.keys(r64.healthByExpert).length > 0 && r64.healthByExpert.math?.health > 0);
check('renderExpertEvolution が進化ツリー表示', renderExpertEvolution(r64).includes('=== Expert Evolution') && renderExpertEvolution(r64).includes('SPLIT'));

// [65] Intelligence Attachments（Kernel 最小・知能はプラグイン）
console.log('\n[65] Intelligence Attachments');
const mon65 = new AttachmentMonitor();
const mgr65 = new AttachmentManager(mon65);
registerBuiltinAttachments(mgr65);
check('登録は遅延（load 前は実体なし）', mgr65.isRegistered('reflection') === true && mgr65.get('reflection') === undefined);
await mgr65.load('reflection');
check('load で実体が生成される', mgr65.get('reflection')?.id === 'reflection');
const boot65 = (await import('./expert-runtime.js')).boot();
const ctx65: AttachmentContext = { text: 'この論文を批判的に評価して', booted: boot65, attach: (id) => mgr65.execute(id, ctx65) };
const refl65 = await mgr65.execute('reflection', ctx65);
check('Reflection: Answer→Reflect→Revise（品質向上）', refl65.quality > 0.7 && refl65.text.includes('再考済み') && refl65.detail.some((d) => d.startsWith('REFLECT')));
await mgr65.load('debate');
const deb65 = await mgr65.execute('debate', ctx65);
check('Debate: 立場を議論して合意（Judge=ACCEPT）', deb65.text.includes('中立的に統合する'), deb65.text);
await mgr65.load('planning');
const pl65 = await mgr65.execute('planning', ctx65);
check('Planning: Goal→SubGoals→Plan→Schedule（AILSM Plan）', pl65.detail.some((d) => d.includes('PLAN')) && pl65.detail.some((d) => d.includes('SCHEDULE')));
const ctx65b: AttachmentContext = { text: '新しいアイデアを考えて', booted: boot65, attach: (id) => mgr65.execute(id, ctx65b) };
await mgr65.load('creativity');
const cre65 = await mgr65.execute('creativity', ctx65b);
check('Creativity: Hypothesis SSA で複数新規仮説', (cre65.text.match(/ /g) ?? []).length >= 2 && cre65.detail.some((d) => d.startsWith('EXPAND')));
const ctx65c: AttachmentContext = { text: '情報を探して', booted: boot65, attach: (id) => mgr65.execute(id, ctx65c) };
await mgr65.load('search');
const s65 = await mgr65.execute('search', ctx65c);
check('Search: Search Runtime で最良経路を採用', s65.text.includes('有望な経路'), s65.text);
const ctx65d: AttachmentContext = { text: 'もし失敗したら想定して', booted: boot65, attach: (id) => mgr65.execute(id, ctx65d) };
await mgr65.load('simulation');
const sim65 = await mgr65.execute('simulation', ctx65d);
check('Simulation: 分岐実行→統合', sim65.text.includes('前提A') && sim65.detail.some((d) => d.startsWith('MERGE')));
const ctx65e: AttachmentContext = { text: 'コードを実装して', booted: boot65, attach: (id) => mgr65.execute(id, ctx65e) };
await mgr65.load('coding');
const cod65 = await mgr65.execute('coding', ctx65e);
check('Coding: code.execute 経由で Harness 委譲', cod65.detail.some((d) => d.startsWith('CAPABILITY: code.execute')) && cod65.detail.some((d) => d.startsWith('HARNESS:')) && cod65.ok);
check('Coding: 検証済みコードのみ成功', cod65.detail.some((d) => d.startsWith('VERIFY: 成功')) && cod65.ok);
const supports65 = (task: string): string => mgr65.list().filter((a) => a.enabled && a.supports(task)).map((a) => a.id).sort().join(',');
check('supports: 批判的評価 → reflection+debate', supports65('この論文を批判的に評価して') === 'debate,reflection');
check('supports: 実装 → coding', supports65('コードを実装して') === 'coding');
check('supports: 計画 → planning', supports65('どうやって進めるか計画して') === 'planning');
const sched65 = attachmentScheduler(mgr65, 'この論文を批判的に評価して', { budget: 0.6 });
check('Executive が予算で Attachment を選択', sched65.length >= 1 && sched65.every((s) => s.budget <= 0.6) && sched65[0].priority > 0);
await mgr65.load('simulation');
const par65 = await mgr65.executeMerged(['reflection', 'debate'], ctx65, 'par');
check('並列実行 + 統合（品質は最良を採用）', par65.ok && par65.quality > 0 && par65.detail[0].startsWith('MERGE(par)'));
check('Monitor に Timeline/Cost/Latency/Accuracy/Calls', mon65.totals().calls >= 4 && mon65.render().includes('=== Attachment Monitor ===') && mon65.timeline().includes('Attachment Timeline'));
await mgr65.disable('debate');
check('disable で参加しなくなる', attachmentScheduler(mgr65, 'この論文を批判的に評価して', { budget: 1.0 }).every((s) => s.id !== 'debate'));
await mgr65.enable('debate');
const bm65 = await runAttachmentBenchmark();
check('Benchmark: 5 モード（なし/Reflection/Debate/Planning/All）', bm65.length === 5);
check('Benchmark: Attachment で品質が上がる', bm65[1].quality > bm65[0].quality && bm65[2].quality > bm65[0].quality);
const best65 = bm65.reduce((a, b) => (b.quality > a.quality ? b : a), bm65[0]);
check('Benchmark: 最良品質を報告', best65.quality > 0.8, `best=${best65.mode} q=${best65.quality.toFixed(2)}`);

// [66] Thinking Modes（Fast / Auto / Deep / Custom + Intelligence Scheduler）
console.log('\n[66] Thinking Modes');
const mgr66 = new AttachmentManager();
registerBuiltinAttachments(mgr66);
await Promise.all((['reflection', 'debate', 'planning', 'creativity', 'search', 'simulation', 'coding'] as const).map((id) => mgr66.load(id)));
const plFast66 = await resolvePipeline('fast', mgr66, 'この論文を批判的にレビューして');
check('Fast: Attachment なし（Kernel→Expert→Answer）', plFast66.length === 0);
const plTrivial66 = await resolvePipeline('auto', mgr66, '2+2を計算して');
check('Auto: 2+2 → Fast Runtime のみ', plTrivial66.length === 0);
const plCrit66 = await resolvePipeline('auto', mgr66, 'この論文を批判的にレビューして');
check('Auto: 批判的レビュー → Reflection+Debate を自動起動', plCrit66.includes('reflection') && plCrit66.includes('debate'), plCrit66.join(','));
const plHigh66 = await resolvePipeline('auto', mgr66, '新しいアルゴリズムを設計して', { budgetMs: 1500 });
check('Auto: 難しいタスク → Planning+Debate+Creativity を自動起動', plHigh66.includes('planning') && plHigh66.includes('debate') && plHigh66.includes('creativity'), plHigh66.join(','));
const plDeep66 = await resolvePipeline('deep', mgr66, 'この論文を批判的にレビューして', { budgetMs: 2000 });
check('Deep: Planning→Debate→Reflection→Simulation を積極利用', ['planning', 'debate', 'reflection', 'simulation'].every((id) => plDeep66.includes(id)), plDeep66.join(','));
const plCustom66 = await resolvePipeline('custom', mgr66, 'この論文を批判的にレビューして', { attachments: ['reflection'] });
check('Custom: ユーザー指定の Attachment のみ', plCustom66.length === 1 && plCustom66[0] === 'reflection');
const pool66 = mgr66.list();
const sched200_66 = intelligenceScheduler(pool66, 200);
const sched1000_66 = intelligenceScheduler(pool66, 1000);
check('Intelligence Scheduler: 時間予算内（sum ≤ budget）', sched200_66.reduce((s, x) => s + x.budgetMs, 0) <= 200 && sched1000_66.reduce((s, x) => s + x.budgetMs, 0) <= 1000);
check('Intelligence Scheduler: 予算が小さいと Attachment が減る', sched1000_66.length > sched200_66.length, `200ms→${sched200_66.length} / 1000ms→${sched1000_66.length}`);
const boot66 = (await import('./expert-runtime.js')).boot();
const thFast66 = await runThinking('この論文を批判的にレビューして', boot66, { mode: 'fast' });
check('runThinking(Fast): 実行なし・品質は基底', thFast66.pipeline.length === 0 && thFast66.result.quality === 0.5);
const thAuto66 = await runThinking('この論文を批判的にレビューして', boot66, { mode: 'auto' });
check('runThinking(Auto): 内訳が可視化（Reflection+Debate の ms）', thAuto66.breakdown.some((b) => b.id === 'reflection' && b.latencyMs > 0) && thAuto66.breakdown.some((b) => b.id === 'debate') && thAuto66.usedMs === thAuto66.breakdown.reduce((s, b) => s + b.latencyMs, 0));
check('runThinking(Auto): 品質が Fast より高い', thAuto66.result.quality > 0.7, thAuto66.result.quality.toFixed(2));
const thCustom66 = await runThinking('この論文を批判的にレビューして', boot66, { mode: 'custom', attachments: ['reflection'] });
check('runThinking(Custom): 指定 Attachment だけ実行', thCustom66.pipeline.join(',') === 'reflection');
const thBudget66 = await runThinking('この論文を批判的にレビューして', boot66, { mode: 'auto', budgetMs: 200 });
check('Thinking Budget 遵守（budget=200ms → usedMs ≤ 200）', thBudget66.usedMs <= 200, `used=${thBudget66.usedMs}ms`);
check('renderThinking が内訳（TOTAL）表示', renderThinking(thAuto66).includes('TOTAL') && renderThinking(thFast66).includes('Attachment なし'));
const tb66 = await runThinkingBenchmark();
check('モード比較ベンチ: Fast/Auto/Deep の 3 行', tb66.length === 3);
const deepQ66 = tb66.find((r) => r.mode === 'Deep')!.quality;
const autoQ66 = tb66.find((r) => r.mode === 'Auto')!.quality;
const fastQ66 = tb66.find((r) => r.mode === 'Fast')!.quality;
check('品質: Deep ≥ Auto > Fast（必要なときだけ高度推論）', deepQ66 >= autoQ66 && autoQ66 > fastQ66, `fast=${fastQ66.toFixed(2)} auto=${autoQ66.toFixed(2)} deep=${deepQ66.toFixed(2)}`);

// [67] Attachment Validation（アーキテクチャの有効性を実証する実験）
console.log('\n[67] Attachment Validation');
check('電力モデル（決定論近似）: 多いほど高い', estimatePower(0, 0, 0.1) < estimatePower(550, 3, 0.5) && estimatePower(550, 3, 0.5) < estimatePower(800, 4, 0.9));
const mode67 = await runModeValidation();
const f67 = mode67.find((r) => r.mode === 'Fast')!;
const a67 = mode67.find((r) => r.mode === 'Auto')!;
const d67 = mode67.find((r) => r.mode === 'Deep')!;
check('実測: レイテンシ Fast < Auto < Deep', f67.latencyMs < a67.latencyMs && a67.latencyMs < d67.latencyMs, `fast=${f67.latencyMs} auto=${a67.latencyMs} deep=${d67.latencyMs}`);
check('実測: 品質 Auto ≥ Fast（高度推論が品質を向上）', a67.quality >= f67.quality && d67.quality >= a67.quality, `fast=${f67.quality.toFixed(2)} auto=${a67.quality.toFixed(2)} deep=${d67.quality.toFixed(2)}`);
check('実測: 電力 Fast < Auto < Deep（議論は電力も消費）', f67.powerMw < a67.powerMw && a67.powerMw < d67.powerMw, `${f67.powerMw}→${a67.powerMw}→${d67.powerMw}mW`);
const abl67 = await runAblation();
check('Ablation: baseline + 7 Attachment + ALL = 9 行', abl67.length === 9);
check('Ablation: baseline = 0.50', abl67[0].config.includes('なし') && abl67[0].quality === 0.5);
const refl67 = abl67.find((r) => r.config === '+reflection')!;
check('Ablation: Reflection だけで品質 +50% 以上', refl67.deltaPct > 50, `+${refl67.deltaPct.toFixed(0)}%`);
const all67 = abl67.find((r) => r.config === 'ALL（並列）')!;
check('Ablation: ALL ≥ 単体の最良（効果が足し算で悪化しない）', all67.quality >= Math.max(...abl67.filter((r) => r.config.startsWith('+')).map((r) => r.quality)), `ALL=${all67.quality.toFixed(2)}`);
check('Ablation: 全 Attachment で +70% 以上', all67.deltaPct > 70, `+${all67.deltaPct.toFixed(0)}%`);
const rob67 = runRobotSimulation();
const rFast67 = rob67.find((r) => r.mode === 'Fast')!;
const rAuto67 = rob67.find((r) => r.mode === 'Auto')!;
const rDeep67 = rob67.find((r) => r.mode === 'Deep')!;
check('ロボット: Fast は 30fps 達成（33ms 閉ループ）', rFast67.meets30fps && rFast67.loopMs <= 34, `${rFast67.loopMs}ms / ${rFast67.fps}fps`);
check('ロボット: Auto は制御タスクを高速に保つ', rAuto67.meets30fps && rAuto67.loopMs === rFast67.loopMs);
check('ロボット: Deep は 30fps 破綻（議論を閉ループに混ぜない）', rDeep67.meets30fps === false && rDeep67.fps < 5, `${rDeep67.fps}fps`);
check('ロボット: 成功率 Fast > Deep（リアルタイムの価値）', rFast67.successRate > rDeep67.successRate, `${rFast67.successRate} vs ${rDeep67.successRate}`);
check('renderModeValidation が表示', renderModeValidation(mode67).includes('power'));
check('renderAblation が delta 表示', renderAblation(abl67).includes('+76%') || renderAblation(abl67).includes('delta'));
check('renderRobotSimulation が 30fps 判定表示', renderRobotSimulation(rob67).includes('30.3') && renderRobotSimulation(rob67).includes('✗'));

// [68] Scientific Validation（再現可能な評価基盤）
console.log('\n[68] Scientific Validation');
check('コーパス: 14 問・5 カテゴリ', SCIENTIFIC_CORPUS.length === 14 && new Set(SCIENTIFIC_CORPUS.map((q) => q.category)).size === 5);
check('品質モデル: fast は難易度に反比例（決定論）', modeQuality('fast', { id: 'a', category: 'math', prompt: '', difficulty: 0.1 }) > modeQuality('fast', { id: 'b', category: 'math', prompt: '', difficulty: 0.9 }));
check('品質モデル: all ≥ debate ≥ fast（OS が能力を引き出す）', modeQuality('all', SCIENTIFIC_CORPUS[0]) >= modeQuality('debate', SCIENTIFIC_CORPUS[0]) && modeQuality('debate', SCIENTIFIC_CORPUS[0]) >= modeQuality('fast', SCIENTIFIC_CORPUS[0]));
const sciB68 = await runReasoningBenchmark(SCIENTIFIC_CORPUS.filter((_, i) => [0, 2, 4, 7, 10, 13].includes(i))); // 難易度分散のある 6 問（高速化）
const acc68 = (m: string): number => sciB68.find((r) => r.mode === m)!.accuracy;
check('Validation B: 正答率が単調増加（fast < reflection < debate ≤ all）', acc68('fast') < acc68('reflection') && acc68('reflection') < acc68('debate') && acc68('all') >= acc68('debate'), sciB68.map((r) => `${r.mode}=${(r.accuracy * 100).toFixed(0)}%`).join(' '));
check('Validation B: レイテンシは実実行で計測', sciB68.every((r) => r.totalLatencyMs >= 0) && sciB68.find((r) => r.mode === 'all')!.totalLatencyMs > 0);
const sciA68 = runLongContextValidation();
check('Validation A: AVM は Long Context より高速・低トークン', sciA68.speedup > 3 && sciA68.tokenReduction > 0.7, `speedup=${sciA68.speedup.toFixed(2)}x red=${(sciA68.tokenReduction * 100).toFixed(1)}%`);
const sciC68 = runRobotValidation();
const cFast68 = sciC68.find((r) => r.mode === 'Fast')!;
const cDeep68 = sciC68.find((r) => r.mode === 'Deep')!;
check('Validation C: Fast は低電力・低温・30fps、Deep は高温', cFast68.meets30fps && cFast68.temperatureC < 40 && cDeep68.meets30fps === false && cDeep68.temperatureC > 40, `fast=${cFast68.temperatureC}°C deep=${cDeep68.temperatureC}°C`);
const sciD68 = await runExecutiveValidation();
const dNone68 = sciD68.find((r) => r.config === 'Executiveなし')!;
const dExec68 = sciD68.find((r) => r.config === 'Executiveあり')!;
check('Validation D: Executive が推論回数と品質を上げる', dExec68.finalQuality > dNone68.finalQuality && dExec68.inferenceCount > dNone68.inferenceCount, `q=${dNone68.finalQuality}→${dExec68.finalQuality}`);
check('Validation D: Meta Executive は少ない推論で同品質', sciD68.find((r) => r.config === 'Meta Executive')!.finalQuality >= dExec68.finalQuality);
const sciF68 = runModelComparison();
const mc0 = sciF68[0];
const mcLast = sciF68[sciF68.length - 1];
const mcFast = sciF68[1];
check('Flagship: 同じモデルでも OS 構成で能力が変わる', mc0.config.includes('Qwen') && mcLast.quality > mc0.quality && mcLast.latencyMs > mc0.latencyMs, `q=${mc0.quality}→${mcLast.quality}`);
check('Flagship: Fast は最速・低電力（AVM の効果）', mcFast.latencyMs < mc0.latencyMs && mcFast.powerMw < mc0.powerMw);

// [69] Real Benchmark Suite（Validation E: 外部ベンチ + レポート自動生成）
console.log('\n[69] Real Benchmark Suite');
check('外部ベンチ 6 種（各 10 問）', ALL_BENCH_SUITES.length === 6 && ALL_BENCH_SUITES.every((s) => s.samples.length === 10));
check('カテゴリ: math/coding/knowledge', ['gsm8k', 'math500'].every((id) => ALL_BENCH_SUITES.find((s) => s.id === id)?.category === 'math') && ['human_eval', 'mbpp', 'livecodebench'].every((id) => ALL_BENCH_SUITES.find((s) => s.id === id)?.category === 'coding') && ALL_BENCH_SUITES.find((s) => s.id === 'mmlu')?.category === 'knowledge');
check('品質モデル: qwen < fast < auto < deep（単調）', configQuality('qwen', 0.5) < configQuality('qwen-fast', 0.5) && configQuality('qwen-fast', 0.5) < configQuality('qwen-auto', 0.5) && configQuality('qwen-auto', 0.5) < configQuality('qwen-deep', 0.5));
check('品質モデル: Thinking は単体より高い', configQuality('qwen-thinking', 0.5) > configQuality('qwen', 0.5));
const rows69 = runExternalBenchmarks();
check('Validation E: 6 スイート × 5 構成 = 30 行', rows69.length === 30);
const overall69 = overallAccuracy(rows69);
const acc69 = (c: string): number => overall69.find((o) => o.config === c)!.accuracy ?? 0;
check('全体正答率: qwen < fast < auto < deep（単調増加）', acc69('qwen') < acc69('qwen-fast') && acc69('qwen-fast') < acc69('qwen-auto') && acc69('qwen-auto') < acc69('qwen-deep'), overall69.map((o) => `${o.config}=${o.accuracy === null ? 'N/A' : (o.accuracy * 100).toFixed(0)}%`).join(' '));
const he69 = rows69.filter((r) => r.suite === 'human_eval');
const heAcc = (c: string): number => he69.find((r) => r.config === c)!.accuracy ?? 0;
check('Qwen Thinking vs ArcAsha: human_eval で thinking(50%) > fast(40%) かつ deep(100%) > thinking', heAcc('qwen-thinking') > heAcc('qwen-fast') && heAcc('qwen-deep') > heAcc('qwen-thinking'), he69.map((r) => `${r.config}=${r.accuracy === null ? 'N/A' : (r.accuracy * 100).toFixed(0)}%`).join(' '));
const ovFast69 = osOverheadProfile('qwen-fast');
const ovDeep69 = osOverheadProfile('qwen-deep');
const llmOf = (p: { components: { component: string; cpuPct: number }[] }): number => p.components.filter((c) => c.component.includes('LLM')).reduce((s, c) => s + c.cpuPct, 0);
check('OS オーバーヘッド: 単体は LLM 100%、OS を増やすほど LLM 割合が下がる', osOverheadProfile('qwen').components[0].cpuPct === 100 && llmOf(ovFast69) > llmOf(ovDeep69) && llmOf(ovDeep69) > 0, `fast LLM=${llmOf(ovFast69)}% deep LLM=${llmOf(ovDeep69)}%`);
check('OS オーバーヘッド: CPU/レイテンシは 100% に収束', ovFast69.components.reduce((s, c) => s + c.cpuPct, 0) === 100 && ovDeep69.components.reduce((s, c) => s + c.latencyPct, 0) === 100);
const json69 = JSON.parse(buildJsonReport(rows69, allOverheadProfiles())) as { version: string; overall: unknown[]; kind: string };
check('report.json: バージョン + 全体結果', json69.version === '1.3.0' && json69.overall.length === 5 && json69.kind === 'simulation');
check('report.csv: ヘッダ + 30 行', buildCsvReport(rows69).split('\n').length === 31 && buildCsvReport(rows69).startsWith('suite,suite_name'));
check('report.md: ベンチ表 + OS オーバーヘッド', buildMarkdownReport(rows69, allOverheadProfiles()).includes('| gsm8k |') && buildMarkdownReport(rows69, allOverheadProfiles()).includes('OS Overhead'));
const files69 = await writeReports('reports/.selftest', rows69, allOverheadProfiles());
check('writeReports: json/csv/md を書き出す', files69.length === 3 && files69.every((f) => f.endsWith('.json') || f.endsWith('.csv') || f.endsWith('.md')));
await rm('reports/.selftest', { recursive: true, force: true });

// [70] Decision Explanation + Simulation/Real 分離
console.log('\n[70] Decision Explanation / Real Device');
const boot70 = (await import('./expert-runtime.js')).boot();
const exp70 = await explainExecutive('新しいアルゴリズムを考えて', boot70, { mode: 'auto', budgetMs: 1000 });
check('Explain: 高複雑度で 4 Attachment を選択（planning/debate/creativity/reflection）', exp70.mode === 'auto' && ['planning', 'debate', 'creativity', 'reflection'].every((id) => exp70.choices.some((c) => c.id === id)), exp70.choices.map((c) => c.id).join(','));
const gain70 = (id: string): number => exp70.choices.find((c) => c.id === id)!.expectedGain;
check('Explain: 期待ゲイン（planning .31 / debate .22 / creativity .28 / reflection .19）', Math.abs(gain70('planning') - 0.31) < 1e-9 && Math.abs(gain70('debate') - 0.22) < 1e-9 && Math.abs(gain70('creativity') - 0.28) < 1e-9 && Math.abs(gain70('reflection') - 0.19) < 1e-9);
check('Explain: 総合期待向上 +34%（最有力 + 相乗効果 3%）', Math.abs(exp70.totalExpectedGain - 0.34) < 1e-9, `${(exp70.totalExpectedGain * 100).toFixed(0)}%`);
check('Explain: 予算と使用時間を表示', exp70.budgetMs === 1000 && exp70.usedMs === 1000);
const expTriv70 = await explainExecutive('2+2を計算して', boot70, { mode: 'auto' });
check('Explain: 2+2 → 選択なし（Fast Runtime）', expTriv70.choices.length === 0 && expTriv70.modeReason.includes('Fast'));
check('renderExplanation が理由・ゲイン・予算を表示', renderExplanation(exp70).includes('Expected Gain : +34%') && renderExplanation(exp70).includes('planning'));
const rd70 = await runRealDeviceBenchmark();
check('Real Device: 未接続なら数値を偽造しない（not-connected）', rd70.status === 'not-connected' && rd70.rows.length === 0 && rd70.note.includes('偽装'));
const rd70b = await runRealDeviceBenchmark({ devices: ['iPhone'], measure: () => ({ latencyMs: 1200, powerMw: 1500, temperatureC: 38, accuracy: 0.7, tokens: 500, memoryMb: 128 }) });
check('Real Device: 実測コールバックで measured 行を生成（6 指標）', rd70b.status === 'connected' && rd70b.rows.length === 4 * 5 && rd70b.rows.every((r) => r.status === 'measured' && r.latencyMs === 1200 && r.tokens === 500 && r.memoryMb === 128));
check('renderRealDeviceBenchmark が Status を表示', renderRealDeviceBenchmark(rd70).includes('not-connected'));
check('Validation 分離: report.json は kind=simulation', (JSON.parse(buildJsonReport(rows69, allOverheadProfiles())) as { kind: string }).kind === 'simulation' && VALIDATION_KIND === 'simulation');

// [71] OS Policy Learning + arcasha CLI（v1.0 リリース）
console.log('\n[71] OS Policy Learning / CLI');
const log71 = new DecisionLog();
check('DecisionLog: 記録と集計', log71.size() === 0);
for (let i = 0; i < 10; i++) {
  log71.append({ task: 't', mode: 'auto', choices: ['planning', 'debate', 'creativity', 'reflection'], expectedGain: 0.22, outcomeQuality: 0.9, outcomeLatencyMs: 1000 });
}
check('DecisionLog: 10 件蓄積・byAttachment', log71.size() === 10 && log71.byAttachment('debate').length === 10);
const gains71 = learnGains(log71);
const debateGain71 = gains71.get('debate')!;
check('ポリシー学習: EMA で期待ゲインが実測値に収束（~0.40）', Math.abs(debateGain71.gain - 0.4) < 0.01 && debateGain71.samples === 10, `gain=${debateGain71.gain.toFixed(3)}`);
check('ポリシー学習: 未観測 Attachment はデータなし', gains71.has('search') === false);
const boot71 = (await import('./expert-runtime.js')).boot();
const before71 = await explainExecutive('新しいアルゴリズムを考えて', boot71, { mode: 'auto', budgetMs: 1000 });
const after71 = await explainWithPolicy('新しいアルゴリズムを考えて', boot71, log71, { mode: 'auto', budgetMs: 1000 });
const gb = (e: { choices: { id: string; expectedGain: number }[] }, id: string): number => e.choices.find((c) => c.id === id)!.expectedGain;
check('Decision Explanation が学習を反映（debate +22% → +40%）', Math.abs(gb(before71, 'debate') - 0.22) < 1e-9 && Math.abs(gb(after71, 'debate') - 0.4) < 1e-9, `before=${(gb(before71, 'debate') * 100).toFixed(0)}% after=${(gb(after71, 'debate') * 100).toFixed(0)}%`);
check('総合期待向上がポリシーで上昇（+34% → +43%）', after71.totalExpectedGain > before71.totalExpectedGain, `before=${(before71.totalExpectedGain * 100).toFixed(0)}% after=${(after71.totalExpectedGain * 100).toFixed(0)}%`);
const pol71 = await runPolicyLearningDemo();
check('policy デモ: 学習前→学習後の説明が出力される', pol71.includes('学習前: debate') && pol71.includes('学習後: debate'));
const cliHelp71 = await runCli(['help']);
check('arcasha CLI: help が v1.0.0 と usage を表示', cliHelp71.includes('ArcAsha v1.0.0') && cliHelp71.includes('arcasha <command>') && cliHelp71.includes('benchmark'));
const cliPol71 = await runCli(['policy']);
check('arcasha CLI: policy がポリシー学習デモを実行', cliPol71.includes('OS Policy Learning'));
const cliVer71 = await runCli(['version']);
check('arcasha CLI: version', cliVer71 === 'ArcAsha v1.0.0');

// [72] Decision Replay + Real Device プラン（v1.1）
console.log('\n[72] Decision Replay / Real Device Plan');
const rep72 = await captureReplay('新しいアルゴリズムを考えて', boot70, { mode: 'auto', budgetMs: 1000 });
check('Replay: 4 ステップを順に記録', replayStepCount(rep72) === 4 && rep72.steps.map((s) => s.round).join(',') === '1,2,3,4');
check('Replay: 各ステップに理由・ゲイン・出力', rep72.steps.every((s) => s.reason.length > 0 && s.expectedGain > 0 && s.latencyMs > 0 && s.output.length > 0));
check('Replay: 最終品質と使用時間', rep72.finalQuality > 0.7 && rep72.usedMs === rep72.steps.reduce((s, x) => s + x.latencyMs, 0));
check('renderReplay: Round1〜4 + Final を表示', renderReplay(rep72).includes('Round1: reflection') && renderReplay(rep72).includes('Round4: planning') && renderReplay(rep72).includes('Final :'));
check('renderReplayStep: 1 コマ再生（GUI アニメ用）', renderReplayStep(rep72, 0).includes('Round1') && renderReplayStep(rep72, 4).startsWith('END'));
check('Real Device プラン: Mac/iPhone15 Pro/iPad M4 × 4 スイート', REAL_DEVICE_PROFILE.devices.length === 3 && REAL_DEVICE_PROFILE.suites.length === 4 && REAL_DEVICE_PROFILE.metrics.length === 6);
check('renderRealDevicePlan が対象・指標を表示', renderRealDevicePlan().includes('iPhone 15 Pro') && renderRealDevicePlan().includes('memoryMb') && renderRealDevicePlan().includes('Simulation とは分離'));
const cliRep72 = await runCli(['replay', 'この論文を批判的に評価して']);
check('arcasha CLI: replay（タスク指定）', cliRep72.includes('Decision Replay') && cliRep72.includes('Round1'));

// [39] AI Performance Monitor（aiperf）
console.log('\n[39] AI Perf Monitor');
const perf39 = new AiPerf();
const tlb39 = new ContextTlb();
const tier39 = new TierManager();
perf39.attach(tlb39, tier39);
perf39.beginCall('math', 18);
perf39.beginCall('search', 42);
perf39.beginCall('math', 6);
perf39.recordPageRequest(false);
perf39.recordPageRequest(true);
perf39.recordPageRequest(true);
const snap39 = perf39.snapshot();
check('CALL 統計（math 2回 / search 1回）', snap39.calls[0].expert === 'search' && snap39.calls.find((c) => c.expert === 'math')?.count === 2);
check('Context Fault Rate', Math.abs(snap39.faultRate - 2 / 3) < 0.001);
check('Expert 利用率（search が最大）', snap39.expertUtilization.search > snap39.expertUtilization.math);
check('aiperf テキスト表示', perf39.render().includes('=== aiperf ===') && perf39.render().includes('TLB Hit Rate'));

// [40] AI Trace（Chrome Trace 互換）
console.log('\n[40] AI Trace');
const tr40 = new AiTrace();
tr40.complete('compile', 1000);
tr40.complete('call:math', 18000);
tr40.complete('reflect', 4000);
const json40 = JSON.parse(tr40.toChromeTrace()) as { traceEvents: unknown[] };
check('Chrome Trace 形式（traceEvents 配列）', Array.isArray(json40.traceEvents) && json40.traceEvents.length === 3);
const ev40 = json40.traceEvents[1] as { name: string; ph: string; dur: number };
check('complete イベント（X）に dur がある', ev40.ph === 'X' && ev40.dur === 18000 && ev40.name === 'call:math');
const rt40 = run('2と3を足して');
const runTrace40 = buildRuntimeTrace(rt40.steps);
const sched40 = buildSchedulerTrace(rt40.events);
check('Runtime/Scheduler Timeline が生成される', runTrace40.length === rt40.steps.length && sched40.length === rt40.events.length);
check('Timeline テキスト表示', renderTimeline(runTrace40).includes('compile'));

// [41] AI Profiler（Hot Expert / Hot Pages / Fault Hotspot）
console.log('\n[41] AI Profiler');
const prof41 = new AiProfiler();
prof41.recordExpert('math', 80);
prof41.recordExpert('search', 10);
prof41.recordExpert('planning', 10);
prof41.recordPageAccess(5, 1);
prof41.recordPageAccess(5, 1);
prof41.recordPageAccess(9, 1);
prof41.recordFault(5);
prof41.recordFault(5);
const p41 = prof41.profile();
check('Hot Expert = math（80%）', p41.hotExpert?.expert === 'math' && p41.hotExpert.share > 0.7);
check('Hot Pages がアクセス順', p41.hotPages[0]?.pageId === 5 && p41.hotPages[0]?.accesses === 2);
check('Fault Hotspot = Page5', p41.faultHotspots[0]?.pageId === 5 && p41.faultHotspots[0]?.faults === 2);
check('profiler テキスト表示', prof41.render().includes('Hot Expert'));

// [42] AI Benchmark（Long Context 比較: Qwen vs ArcAsha）
console.log('\n[42] AI Benchmark');
const syn42 = synthesizeContext('論文', 100, 64);
check('合成 Context が 100 ページ', syn42.graph.nodes.filter((n) => n.kind === 'page').length === 100);
check('ページ種別の決定論配置', pageKindOfIndex(0) === 'equation' && pageKindOfIndex(5) === 'search' && pageKindOfIndex(3) === 'summary');
const bench42 = runLongContextBenchmark(defaultQuestions(), 200, 64);
const t42 = bench42.totals;
check('Token 削減率 > 70%', t42.tokenReduction > 0.7, `${(t42.tokenReduction * 100).toFixed(1)}%`);
check('ページロード率 < 50%', t42.avgPageLoadRatio < 0.5, `${(t42.avgPageLoadRatio * 100).toFixed(1)}%`);
check('Speedup > 1', t42.speedup > 1, `${t42.speedup.toFixed(2)}x`);
check('TLB Hit Rate が計測される', t42.tlbHitRate > 0);
check('Context Fault Rate が計測される', t42.totalFaultRate > 0 && t42.totalFaultRate <= 1);

// [43] Observability 統合デモ
console.log('\n[43] Observability 統合');
const obs = runObservabilityDemo();
check('Chrome Trace が有効な JSON', (() => { try { JSON.parse(obs.chromeTrace); return true; } catch { return false; } })());
check('Timeline イベントが生成される', obs.traceEventCount > 0);
check('aiperf に CALL 統計', obs.perf.calls.length > 0);
check('profiler に Hot Expert', obs.profile.hotExpert !== null);
check('ベンチ: Token 削減率 > 70%', obs.headline.tokenReduction > 0.7, `${(obs.headline.tokenReduction * 100).toFixed(1)}%`);
check('ベンチ: Speedup > 1', obs.headline.speedup > 1, `${obs.headline.speedup.toFixed(2)}x`);
check('ベンチ: Fault Rate / TLB Hit が揃う', obs.headline.faultRate >= 0 && obs.headline.tlbHitRate > 0);

// [73] Hierarchy Runtime（Hierarchical Runtime Intelligence）
console.log('\n[73] Hierarchy Runtime');
const { buildHierarchy } = await import('../hierarchy/hierarchy.js');
const { runHierarchy, detectRole, hierarchySnapshot } = await import('../hierarchy/hierarchy-runtime.js');
const h73 = buildHierarchy();
check('階層: Master 配下に 5 Caravan（Role 付き）', h73.kind === 'master' && h73.children.length === 5 && h73.children.every((c) => c.kind === 'caravan' && !!c.role));
check('階層: Caravan 配下に Device', h73.children.every((c) => c.children.length > 0 && c.children[0].kind === 'device'));
check('階層: Device 配下に Expert', h73.children[0].children[0].children.length > 0 && h73.children[0].children[0].children[0].kind === 'expert');
check('Role 判定: 画像→Vision', detectRole('画像から物体を検出して') === 'Vision');
check('Role 判定: 翻訳→Language', detectRole('この文章を翻訳して') === 'Language');
check('Role 判定: 計算→Math', detectRole('x^2+3x+2=0を解いて') === 'Math');
const hr73 = await runHierarchy(buildHierarchy(), '画像から物体を検出して');
check('階層実行: 判断の連鎖 master>caravan>device>expert', hr73.steps.length === 4 && hr73.steps.map((s) => s.level).join('>') === 'master>caravan>device>expert');
check('階層実行: Master は Vision Caravan へ委譲', hr73.steps[0].decision.includes('Caravan') && hr73.steps[0].role === 'Vision');
check('階層実行: Expert が実行', hr73.steps[3].level === 'expert' && hr73.steps[3].role === 'vision');
check('階層学習: 各階層の Memory に記録', hr73.root.memory.entries.length > 0 && hr73.root.children[0].memory.entries.length > 0);
check('階層学習: 要約が上位へ集約（情報要約）', hr73.summary.includes('Caravan') && hr73.summary.includes('avg'));
const snap73 = hierarchySnapshot(buildHierarchy());
check('スナップショット: 各階層に Budget と自律度を持つ', snap73.children[0].budget.timeMs > 0 && snap73.children[0].decision.autonomy > 0);
const hr73b = await runHierarchy(buildHierarchy(), '画像から物体を検出して');
check('決定論: 同じタスクで同じ判断連鎖', JSON.stringify(hr73.steps.map((s) => s.decision)) === JSON.stringify(hr73b.steps.map((s) => s.decision)));

// [74] Caravan スケーラビリティ（Validation F — キャラバン分割がスケールする実証）
console.log('\n[74] Caravan スケーラビリティ');
const { runCaravanBenchmark } = await import('../bench/caravan.js');
const cb74 = runCaravanBenchmark();
check('キャラバン数 = ceil(N/10)', cb74[1].devices === 100 && cb74[1].caravans === 10);
check('1000 台でキャラバン 100', cb74[3].devices === 1000 && cb74[3].caravans === 100);
check('10000 台でキャラバン 1000', cb74[5].devices === 10000 && cb74[5].caravans === 1000);
check('フラットの管理対象 = N', cb74[5].flatManaged === 10000);
check('キャラバンの管理対象 = キャラバン数+1', cb74[5].caravanManaged === 1001);
check('10000 台で管理コスト約 10x 削減', cb74[5].reductionX > 9 && cb74[5].reductionX < 10);
check('探索コスト: キャラバン = キャラバン数+10', cb74[5].caravanSearch === 1010);
check('ホップ: フラット1 → キャラバン2', cb74[5].hopsFlat === 1 && cb74[5].hopsCaravan === 2);
check('N が 1000x でも管理対象は 1000x 未満（圧縮）', cb74[5].caravanManaged / cb74[0].caravanManaged < 1000);

// [75] Cognitive Graph Runtime（Composable Intelligence Runtime）
console.log('\n[75] Cognitive Graph Runtime');
const { AI_POOL } = await import('../cognitive/pool.js');
const { composeTeam, detectRoles, canConnect } = await import('../cognitive/capability-graph.js');
const { runCognitive } = await import('../cognitive/runtime.js');
const { TeamLearner } = await import('../cognitive/team-learning.js');
const { KnowledgeOasis, makeLesson } = await import('../cognitive/oasis.js');
check('AI Pool: 8 Expert が未所属', AI_POOL.length === 8);
const vision75 = AI_POOL.find((e) => e.id === 'vision')!;
const physics75 = AI_POOL.find((e) => e.id === 'physics')!;
const planning75 = AI_POOL.find((e) => e.id === 'planning')!;
check('凸凹=データ型: vision→physics 接続可', canConnect(vision75, physics75));
check('凸凹=データ型: planning→vision は型不一致で接続不可', !canConnect(planning75, vision75));
check('Role 検出: ドローン設計 → planning/physics/coding を含む', (() => { const r = detectRoles('自律飛行ドローンを設計して'); return r.includes('planning') && r.includes('physics') && r.includes('coding'); })());
check('Role 検出: 方程式 → math', detectRoles('x^2+3x+2=0を解いて').includes('math'));
const ct75 = composeTeam(AI_POOL, '自律飛行ドローンを設計して');
check('編成: 実行順が型チェーン（planning→vision→physics）', ct75.order[0] === 'planning' && ct75.order[1] === 'vision' && ct75.order[2] === 'physics');
check('編成: vision→physics が直接配線（object-list）', ct75.graph.some((g) => g.from === 'vision' && g.to === 'physics' && g.via === 'object-list'));
const cr75 = await runCognitive(ct75, '自律飛行ドローンを設計して');
check('実行: 全 Expert が共有メモリに IR を書く', cr75.memory.length === ct75.members.length);
check('実行: IR で会話（自然言語でない型付きデータ）', cr75.steps.every((s) => s.ir.includes(':') && s.ir.includes('[')));
const tl75 = new TeamLearner();
tl75.record('planning>vision>physics>coding', true, 0.95);
tl75.record('planning>vision>physics>coding', true, 0.9);
tl75.record('planning>vision>coding', false, 0.4);
check('Team Learning: 成功率 100% / 0% を学習', tl75.successRate('planning>vision>physics>coding') === 1 && tl75.successRate('planning>vision>coding') === 0);
check('Team Learning: 成功率の高いチームを推奨', tl75.recommend(['planning>vision>coding', 'planning>vision>physics>coding']) === 'planning>vision>physics>coding');
const oasis75 = new KnowledgeOasis();
oasis75.record({ task: 'ドローン設計', team: ['planning', 'vision', 'physics', 'coding'], graph: [], hypothesis: ['H1'], result: 'success', quality: 0.95, lesson: makeLesson('ドローン設計', ['planning', 'vision', 'physics', 'coding'], true, 0.95), confidence: 0.9, at: Date.now() });
check('Oasis: 類似タスク検索（Runtime Knowledge Base）', oasis75.search('ドローン').length === 1);
check('Oasis: 権限（expert は Task/Reasoning だけ・team は見えない）', (() => { const v = oasis75.view('expert', oasis75.all()[0]); return v.task !== undefined && v.team === undefined; })());
check('Oasis: Lesson が保存される', oasis75.lessons()[0].includes('LESSON'));

// [76] Oasis / Team Learning 効果（Validation G — モデルを再学習しなくても OS が賢くなる）
console.log('\n[76] Oasis / Team Learning 効果');
const { runOasisBenchmark } = await import('../bench/oasis.js');
const ob76 = runOasisBenchmark(1000);
check('Validation G: 4 フェーズ記録', ob76.naive.length === 4 && ob76.learned.length === 4);
check('Validation G: 成功率が改善（Learned > Naive）', ob76.final.learned.successRate > ob76.final.naive.successRate);
check('Validation G: 平均遅延が改善（Learned < Naive）', ob76.final.learned.avgLatencyMs < ob76.final.naive.avgLatencyMs);
check('Validation G: 平均品質が改善（Learned > Naive）', ob76.final.learned.avgQuality > ob76.final.naive.avgQuality);
check('Validation G: 学習が進むほど成功率が高い（late >= warmup）', ob76.learned[3].successRate >= ob76.learned[0].successRate);
check('Validation G: 改善が正の値', ob76.final.improvement.successRate > 0 && ob76.final.improvement.latencyMs > 0);

// [77] Lexer / Normalizer エッジケース（トークン分類・意図・属性・数値抽出）
console.log('\n[77] Lexer / Normalizer エッジケース');
// ── tokenize ──
check('空文字 → トークンなし', tokenize('').length === 0);
check('空白のみ → トークンなし', tokenize('   ').length === 0);
check('記号のみ → トークンなし（読み飛ばし）', tokenize('!!!').length === 0);
check('小数 → number', (() => { const t = tokenize('3.14'); return t.length === 1 && t[0].type === 'number' && t[0].value === '3.14'; })());
check('単変数 → variable', (() => { const t = tokenize('x'); return t.length === 1 && t[0].type === 'variable' && t[0].value === 'x'; })());
check('数式 → math（分割しない）', (() => { const t = tokenize('x+2=5'); return t.length === 1 && t[0].type === 'math' && t[0].value === 'x+2=5'; })());
check('日本語 → word', (() => { const t = tokenize('円の面積'); return t.length === 1 && t[0].type === 'word' && t[0].value === '円の面積'; })());
check('数値+演算子+数値を分離', (() => { const t = tokenize('2 + 3'); return t.length === 3 && t[0].type === 'number' && t[1].type === 'math' && t[2].type === 'number'; })());
// ── normalize ──
const nz1 = normalize('こんにちは世界', tokenize('こんにちは世界'));
check('未知入力 → intent=unknown', nz1.intent === 'unknown');
check('未知入力 → domain=unknown', nz1.domain === 'unknown');
check('未知入力 → confidence=0', nz1.confidence === 0);
const nz2 = normalize('足して引いて', tokenize('足して引いて'));
check('複数アクション抽出', nz2.actions.includes('ACTION_ADD') && nz2.actions.includes('ACTION_SUBTRACT'));
const nz3 = normalize('半径10の円の面積を求めて', tokenize('半径10の円の面積を求めて'));
check('属性 radius=10', nz3.attributes.some((a) => a.name === 'radius' && a.value === '10'));
check('出力 area', nz3.output === 'area');
const nz4 = normalize('3と5を足して', tokenize('3と5を足して'));
check('numbers=[3,5]', nz4.numbers.length === 2 && nz4.numbers[0] === 3 && nz4.numbers[1] === 5);
const nz5 = normalize('x^2 を積分して', tokenize('x^2 を積分して'));
check('rawMath 抽出', nz5.rawMath.includes('x^2'));
check('ACTION_INTEGRAL', nz5.actions.includes('ACTION_INTEGRAL'));

// [78] Attachment エッジケース（ランタイム検証・不正入力）
console.log('\n[78] Attachment エッジケース');
// makeResult の quality クランプ
check('makeResult: quality 1.5 → 1 にクランプ', makeResult('t', 1.5, 10, 0, []).quality === 1);
check('makeResult: quality -0.5 → 0 にクランプ', makeResult('t', -0.5, 10, 0, []).quality === 0);
check('makeResult: quality NaN → 0 にクランプ', makeResult('t', NaN, 10, 0, []).quality === 0);
check('makeResult: quality 0.7 はそのまま', makeResult('t', 0.7, 10, 0, []).quality === 0.7);
// attachmentScheduler の不正入力
const mgr78 = new AttachmentManager();
registerBuiltinAttachments(mgr78);
await Promise.all(BUILTIN_ATTACHMENT_IDS.map((id) => mgr78.load(id)));
check('attachmentScheduler: budget 負数 → 空', attachmentScheduler(mgr78, 'この論文を批判的に評価して', { budget: -1 }).length === 0);
check('attachmentScheduler: budget NaN → 空', attachmentScheduler(mgr78, 'この論文を批判的に評価して', { budget: NaN }).length === 0);
check('attachmentScheduler: max=0 → 空', attachmentScheduler(mgr78, 'この論文を批判的に評価して', { max: 0 }).length === 0);
check('attachmentScheduler: max 負数 → 空', attachmentScheduler(mgr78, 'この論文を批判的に評価して', { max: -1 }).length === 0);
// AttachmentManager.execute の id 検証と executeParallel の空配列
const mgr78b = new AttachmentManager();
registerBuiltinAttachments(mgr78b);
await mgr78b.load('reflection');
const boot78 = (await import('./expert-runtime.js')).boot();
const ctx78: AttachmentContext = { text: '評価して', booted: boot78, attach: (id) => mgr78b.execute(id, ctx78) };
await expectThrowAsync('execute: 空 id でエラー', () => mgr78b.execute('', ctx78));
await expectThrowAsync('execute: 未登録 id でエラー', () => mgr78b.execute('unknown-att', ctx78));
const parEmpty = await mgr78b.executeParallel([], ctx78);
check('executeParallel: 空配列 → 空オブジェクト', Object.keys(parEmpty).length === 0);

// [79] Bench エッジケース（CSV エスケープ・ゼロ除算防御）
console.log('\n[79] Bench エッジケース');
// CSV エスケープ（カンマ・引用符を含む値の安全化）
const csvRow79: BenchResultRow = {
  suite: 'gsm8k', suiteName: 'カンマ,入り"値"', category: 'math', config: 'qwen', configName: 'Qwen,1.5B', samples: 10, pass: 5, accuracy: 0.5, avgQuality: 0.5,
};
const csvOut79 = buildCsvReport([csvRow79]);
check('CSV: カンマ・引用符入り値をエスケープ', csvOut79.includes('"カンマ,入り""値"""'));
check('CSV: configName のカンマをエスケープ', csvOut79.includes('"Qwen,1.5B"'));
// CSV エスケープ（改行を含む値もクォートで保持）
const csvRow79nl: BenchResultRow = { ...csvRow79, suiteName: '改行\n入り' };
const csvOut79nl = buildCsvReport([csvRow79nl]);
check('CSV: 改行入り値をクォートで保持', csvOut79nl.includes('"改行\n入り"'));
// 空サンプルのスイート（no-data 契約: 0 ではなく null）
const emptySuite79: BenchSuite = { id: 'empty', name: 'Empty', category: 'math', samples: [] };
const rowsEmpty79 = runExternalBenchmarks([emptySuite79], ['qwen']);
check('空サンプル: accuracy=null（no-data）', rowsEmpty79[0].accuracy === null && rowsEmpty79[0].avgQuality === null);
// overallAccuracy の空 rows（no-data）
const overallEmpty79 = overallAccuracy([]);
check('overallAccuracy: 空 rows で accuracy=null', overallEmpty79.every((o) => o.accuracy === null));
// renderCaravanBenchmark の空配列
check('renderCaravanBenchmark: 空配列で（データなし）', renderCaravanBenchmark([]).includes('データなし'));

// [80] 実行基盤エッジケース（state 検証・numericValues 優先・AVM）
console.log('\n[80] 実行基盤エッジケース');
// execution.ts: 不正 state のフォールバック
const execBad80 = createExecutionContext({ nodes: [], edges: [] }, 1, 'p', 'math').exec;
check('createExecutionContext: state=created', execBad80.state === 'created');
// 不正 state を持つノードを直接構築 → toExec が 'created' にフォールバックするか
const badGraph80 = new AilsmBuilder();
const badExecId = badGraph80.addNode('execution', 'p:math', 'unknown', {
  contextId: 1, owner: 'p', expert: 'math', state: 'invalid-state', currentPage: 0, currentChunk: 0, currentSpan: 0, cursor: 0, attention: [], hypothesis: '', vars: [], callStack: [], activeExperts: ['math'], residentPages: [], stack: [],
});
const execOfBad80 = executionOf(badGraph80.graph(), badExecId);
check('toExec: 不正 state → created にフォールバック', execOfBad80?.state === 'created');
const frameBad80 = pushFrame(badGraph80.graph(), badExecId, 'branchA', 'H1').frame;
check('pushFrame: frame state=active', frameBad80.state === 'active');
// executor.ts: numericValues は value 属性を優先（min をオペランドにしない）
const exeGraph80 = new AilsmBuilder();
const task80 = exeGraph80.addNode('task', 'solve', 'unknown', { domain: 'math', intent: 'solve', actions: ['ACTION_ADD'] });
const val80 = exeGraph80.addNode('value', 'number', 'number', { min: 0, value: 2 }); // min を先に
const val81 = exeGraph80.addNode('value', 'number', 'number', { value: 3, min: 0 });
exeGraph80.connect(task80, val80, 'uses');
exeGraph80.connect(task80, val81, 'uses');
const exeRes80 = execute(exeGraph80.graph());
check('execute: 2+3=5（value 属性を優先・min をオペランドにしない）', exeRes80.resolved && exeRes80.value === 5, String(exeRes80.value));
// avm.ts: runAvmDemo の maxLoadedRatio が 0〜1
const avmDemo80 = runAvmDemo();
check('AVM デモ: maxLoadedRatio は 0〜1', avmDemo80.maxLoadedRatio > 0 && avmDemo80.maxLoadedRatio <= 1, String(avmDemo80.maxLoadedRatio));

// [81] Caravan Notebook（Single Source of Truth for Task State）
console.log('\n[81] Caravan Notebook（Single Source of Truth）');
const { CaravanNotebook, NOTEBOOK_SECTIONS } = await import('../cognitive/notebook.js');
const { verifyCaravanArtifact, detectCaravanDomain, verifyAilsaProgram } = await import('../cognitive/caravan-verifier.js');
const { runCaravan, fixedCaravan } = await import('../cognitive/caravan-loop.js');
// TeamLearner / KnowledgeOasis は [75] で import 済み
check('Notebook: セクションが 10 種（TASK〜FINAL_DIAGNOSIS）', NOTEBOOK_SECTIONS.length === 10 && NOTEBOOK_SECTIONS.includes('task') && NOTEBOOK_SECTIONS.includes('final-diagnosis'));
const nb81 = new CaravanNotebook('ロボットの制御を実装して');
check('Notebook: v0 初期化（TASK に objective）', nb81.version === 0 && nb81.entriesOf('task').length === 1);
check('Notebook: snapshot は immutable な v0（entries が frozen）', Object.isFrozen(nb81.snapshot().entries) && nb81.snapshot().entries.length === 1);
check('Notebook: snapshot 本体も frozen（Decision Replay 保護）', Object.isFrozen(nb81.snapshot()));
nb81.append('plan', 'plan', 'plan: [steps=2]', 'planning', { round: 1 });
check('Notebook: append で v1 へ', nb81.version === 1 && nb81.entriesOf('plan').length === 1);
check('Notebook: 過去 snapshot は不変（v0 はそのまま / Decision Replay）', nb81.snapshot(0).entries.length === 1 && nb81.snapshot(1).entries.length === 2);
check('Notebook: 不正 IR キーを拒否', (() => { try { nb81.append('plan', 'BadKey', 'plan: [x]', 'planning'); return false; } catch { return true; } })());
const restricted81 = { id: 'coding', name: 'Coding', role: 'coding', readSections: ['task', 'plan'] as const, writeSections: ['analysis'] as const };
check('Notebook: writeSections 契約違反を拒否', (() => { try { nb81.append('plan', 'plan', 'plan: [x]', 'coding', { writer: restricted81 }); return false; } catch { return true; } })());
check('Notebook: view は readSections だけ（Need-to-know）', nb81.view(restricted81).every((e) => e.section === 'task' || e.section === 'plan'));
check('Notebook: history が v0→vN を積む', nb81.history().length === 2 && nb81.history()[0].version === 0 && nb81.history()[1].version === 1);

// [82] Caravan Loop（PLAN → EXECUTE → OBSERVE → VERIFY → REPLAN）
console.log('\n[82] Caravan Loop（PLAN→EXECUTE→OBSERVE→VERIFY→REPLAN）');
const ok82 = await runCaravan({ task: '自律飛行ドローンの制御コードを実装して', team: fixedCaravan('自律飛行ドローンの制御コードを実装して') });
check('Loop: 成功（verified / rounds=1）', ok82.success && ok82.stopReason === 'verified' && ok82.rounds.filter((x) => x.phase === 'PLAN').length === 1);
check('Loop: 全状態が Notebook に（Single Source of Truth）', ok82.notebook.entriesOf('plan').length >= 1 && ok82.notebook.entriesOf('final-diagnosis').length === 1);
const rep82 = await runCaravan({ task: 'ドローンの衝突回避コードを再試行して', team: fixedCaravan('ドローンの衝突回避コードを再試行して') });
check('Loop: FAIL→ERRORS→REPLAN→PASS（rounds=2）', rep82.success && rep82.rounds.some((x) => x.phase === 'REPLAN') && rep82.notebook.entriesOf('errors').length >= 1);
check('Loop: 2 ラウンド目で成功（failFirst）', rep82.rounds.filter((x) => x.phase === 'PLAN').length === 2);
const max82 = await runCaravan({ task: '絶対に失敗して', team: fixedCaravan('絶対に失敗して'), budget: { maxRounds: 1 } });
check('Loop: Round 上限で停止（max-rounds / success=false）', !max82.success && max82.stopReason === 'max-rounds');
const bgt82 = await runCaravan({ task: '絶対に失敗して', team: fixedCaravan('絶対に失敗して'), budget: { thinkingBudgetMs: 1 } });
check('Loop: 思考予算枯渇で停止（budget-exhausted）', !bgt82.success && bgt82.stopReason === 'budget-exhausted');
check('Loop: remainingBudgetMs は 0 以上', bgt82.remainingBudgetMs >= 0);
const thr82 = { id: 'throwing', name: 'Throwing', role: 'coding', readSections: ['task'] as const, writeSections: ['analysis'] as const, execute: async () => { throw new Error('boom'); } };
const thrRun82 = await runCaravan({ task: 'コードを実装して', team: [thr82] });
check('Loop: execute 例外 → 中断せず失敗状態（ERRORS / 最終診断）', !thrRun82.success && thrRun82.notebook.entriesOf('errors').length >= 1 && thrRun82.finalDiagnosis !== undefined);

// [83] Caravan Verifier（成果物検証 + AILSA validator 接続）
console.log('\n[83] Caravan Verifier（成果物検証 + AILSA validator 接続）');
const nbv83 = new CaravanNotebook('sort関数を実装して');
nbv83.append('plan', 'plan', 'plan: [steps=2]', 'planning', { round: 1 });
nbv83.append('analysis', 'program', 'program: [plan=motor-control-v1, lines=8]', 'coding', { round: 1 });
check('Verifier: coding の正しい program → ok', verifyCaravanArtifact(nbv83, 'coding').ok);
nbv83.append('analysis', 'program', 'program: [broken', 'coding', { round: 2 });
check('Verifier: coding の壊れた program → fail', !verifyCaravanArtifact(nbv83, 'coding').ok);
const nbm83 = new CaravanNotebook('x^2+3x+2=0を解いて');
nbm83.append('plan', 'plan', 'plan: [steps=2]', 'planning', { round: 1 });
nbm83.append('analysis', 'solution', 'solution: x=5', 'math', { round: 1 });
check('Verifier: math の正しい solution → ok', verifyCaravanArtifact(nbm83, 'math').ok);
nbm83.append('analysis', 'solution', 'solution: y=5', 'math', { round: 2 });
check('Verifier: math の不正 solution（x= でない）→ fail', !verifyCaravanArtifact(nbm83, 'math').ok);
nbm83.append('analysis', 'solution', 'solution: x=--', 'math', { round: 3 });
check('Verifier: math の非数値 solution（x=--）→ fail', !verifyCaravanArtifact(nbm83, 'math').ok);
nbm83.append('analysis', 'solution', 'solution: x=3.14', 'math', { round: 4 });
check('Verifier: math の小数 solution（x=3.14）→ ok', verifyCaravanArtifact(nbm83, 'math').ok);
check('Verifier: detectCaravanDomain（coding/math・大文字小文字非依存）', detectCaravanDomain('コードを実装して') === 'coding' && detectCaravanDomain('Implement a function') === 'coding' && detectCaravanDomain('x^2=4を解いて') === 'math');
// セクション制約: plan セクションに program があっても analysis になければ fail
const nbs83 = new CaravanNotebook('sort関数を実装して');
nbs83.append('plan', 'plan', 'plan: [steps=2]', 'planning', { round: 1 });
nbs83.append('plan', 'program', 'program: [plan=x, lines=1]', 'planning', { round: 1 });
check('Verifier: program は analysis セクションから（plan は不可）→ fail', !verifyCaravanArtifact(nbs83, 'coding').ok);
const call83 = (id: string): Instruction => ({ opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'reasoning' }, { slot: Slot.TASK_ID, value: id }] });
const ret83 = (id: string): Instruction => ({ opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: id }, { slot: Slot.OUTPUT, value: 'ok' }] });
check('Verifier: AILSA 有効 program → ok', verifyAilsaProgram([call83('1'), call83('2'), ret83('1')]).ok);
check('Verifier: AILSA 無効 program（RETURN RETURN）→ fail', !verifyAilsaProgram([ret83('1'), ret83('2')]).ok);

// [84] Oasis 保存 + Decision Replay（完成 Notebook snapshot / 成功・失敗 Team・Plan・最終診断）
console.log('\n[84] Oasis 保存 + Decision Replay');
const oasis84 = new KnowledgeOasis();
const learner84 = new TeamLearner();
await runCaravan({ task: '自律飛行ドローンの制御コードを実装して', team: fixedCaravan('自律飛行ドローンの制御コードを実装して'), oasis: oasis84, learner: learner84 });
await runCaravan({ task: '絶対に失敗して', team: fixedCaravan('絶対に失敗して'), budget: { maxRounds: 1 }, oasis: oasis84, learner: learner84 });
check('Oasis: 完成 Notebook snapshot が保存される', oasis84.all().some((e) => e.notebookSnapshot !== undefined && e.notebookSnapshot.version >= 0));
check('Oasis: Plan と最終診断が保存される', oasis84.all().some((e) => e.plan !== undefined && e.diagnosis !== undefined));
check('Oasis: 成功/失敗が記録される', oasis84.all().some((e) => e.result === 'success') && oasis84.all().some((e) => e.result === 'fail'));
check('Oasis: recommend が成功を優先（次回推薦材料）', oasis84.recommend('ドローン').length > 0 && oasis84.recommend('ドローン')[0].result === 'success');
const ok84 = await runCaravan({ task: '自律飛行ドローンの制御コードを実装して', team: fixedCaravan('自律飛行ドローンの制御コードを実装して') });
check('Decision Replay: notebook.history() が v0→vN を返す', ok84.notebook.history().length >= 3 && ok84.notebook.history()[0].version === 0);
check('Decision Replay: 最終 snapshot が確定状態を持つ', ok84.finalSnapshot.entries.length >= 4);
check('Team Learning: 完了後に記録される', learner84.samples('planning>coding') >= 1);

// [85] Recovery Harness（Notebook=状態 / 検証駆動エラー回復閉ループ。性能改善は主張しない）
console.log('\n[85] Recovery Harness（Notebook=状態 / 検証駆動エラー回復閉ループ）');
const { RecoveryHarness, createAttemptArtifactHarness, defaultRecoveryPolicy, buildAttemptTask, formatDecision, artifactKeyFor, runRecoveryOnce } = await import('../cognitive/recovery-harness.js');
const { verifyArtifactOnly } = await import('../cognitive/caravan-verifier.js');
// CaravanNotebook は [81] で import 済み
const { HarnessTaskError } = await import('../harness/types.js');

// --- 型 / 純関数（決定論） ---
check('Recovery: ドメイン別アーティファクトキー', artifactKeyFor('coding') === 'program' && artifactKeyFor('math') === 'solution' && artifactKeyFor('generic') === 'analysis');
check('Recovery: formatDecision は IR（根拠を保持）', formatDecision({ action: 'Replan', reason: 'plan が検証を満たさない' }) === 'decision: [action=Replan, reason="plan が検証を満たさない"]');
check('Recovery: AddExpert は addedCapability を保持', formatDecision({ action: 'AddExpert', reason: '能力追加', addedCapability: 'coding' }).includes('addedCapability=coding'));
// カスタム selectStrategy が構造文字（" / [ / ]）を含む理由を返しても IR が壊れない
const dec85 = formatDecision({ action: 'Retry', reason: 'quoted "reason" [x]', addedCapability: 'a]b' });
check('Recovery: formatDecision は構造文字をサニタイズ（" / [ / ]）', dec85.includes('reason="quoted \\"reason\\" (x)"') && dec85.includes('addedCapability=a)b') && !dec85.includes('[x]'));
const ctxUnit85 = (verifier: string, message: string): Parameters<typeof defaultRecoveryPolicy>[0] => ({
  notebook: new CaravanNotebook('テスト'),
  attempt: 1,
  verification: { ok: false, issues: [{ verifier, message }] },
  failureHistory: [],
});
check('Recovery: Plan 検証失敗 → Replan', defaultRecoveryPolicy(ctxUnit85('Plan', 'PLAN セクションに plan が無い')).action === 'Replan');
check('Recovery: 形式不良 → Retry', defaultRecoveryPolicy(ctxUnit85('Artifact', 'program が閉じた IR 形式でない: x')).action === 'Retry');
check('Recovery: アーティファクト欠落 → AddExpert(coding)', defaultRecoveryPolicy(ctxUnit85('Artifact', 'coding: analysis セクションに program が無い')).action === 'AddExpert');
check('Recovery: 実行基盤の失敗 → Retry', defaultRecoveryPolicy({ ...ctxUnit85('Executor', 'executor-failed: boom'), failureHistory: [{ attempt: 1, kind: 'executor-failed', issue: 'executor-failed: boom', at: 0 }] }).action === 'Retry');

// --- buildAttemptTask: attempt / recoveryContext を注入（Notebook 状態を task へ合成） ---
const nbctx85 = new CaravanNotebook('ドローン制御を実装して');
nbctx85.append('errors', 'error', 'error: "verify: Artifact 形式不良"', 'recovery', { round: 1 });
const attemptTask85 = buildAttemptTask({ taskId: 't1', text: 'ドローン制御を実装して' }, nbctx85, 2);
check('Recovery: buildAttemptTask が attempt=2 を注入', attemptTask85.metadata?.attempt === 2);
check('Recovery: buildAttemptTask が recoveryContext を注入', typeof attemptTask85.metadata?.recoveryContext === 'string' && attemptTask85.text.includes('recovery context'));

// --- 閉ループ: attempt1 形式不良 → Retry → attempt2 成功 ---
const nbRetry85 = new CaravanNotebook('ドローン制御を実装して');
const retryExecutor85 = createAttemptArtifactHarness({
  domain: 'coding',
  produce: (attempt) => (attempt === 1 ? 'program: [broken' : 'program: [plan=motor-control-v1, lines=8]'),
});
const rhRetry85 = new RecoveryHarness({ executor: retryExecutor85, notebook: nbRetry85, domain: 'coding' });
const resRetry85 = await runRecoveryOnce(rhRetry85, { taskId: 'retry', text: 'ドローン制御を実装して' });
check('Recovery: Retry 閉ループで完了（attempts=2）', resRetry85.ok && resRetry85.metadata?.attempts === 2);
check('Recovery: Notebook に DECISIONS(action=Retry) が記録', nbRetry85.entriesOf('decisions').some((e) => e.value.includes('action=Retry')));
check('Recovery: Notebook に ERRORS が記録', nbRetry85.entriesOf('errors').length === 1);
check('Recovery: 最終診断（FINAL_DIAGNOSIS）が確定', nbRetry85.entriesOf('final-diagnosis').length === 1);
check('Recovery: snapshot が決定論的に v0→vN を積む（Decision Replay）', nbRetry85.history().length >= 5 && nbRetry85.history()[0].version === 0);

// --- 実行基盤の失敗（failed イベント）→ Retry → 成功 ---
const nbExec85 = new CaravanNotebook('ドローン制御を実装して');
const execFail85 = createAttemptArtifactHarness({
  domain: 'coding',
  produce: (attempt) => (attempt === 1 ? undefined : 'program: [plan=v2, lines=8]'),
});
const rhExec85 = new RecoveryHarness({ executor: execFail85, notebook: nbExec85, domain: 'coding' });
const resExec85 = await runRecoveryOnce(rhExec85, { taskId: 'exec', text: 'ドローン制御を実装して' });
check('Recovery: 実行失敗→Retry→成功（attempts=2）', resExec85.ok && resExec85.metadata?.attempts === 2);
check('Recovery: 実行失敗が ERRORS に executor-failed で記録', nbExec85.entriesOf('errors').some((e) => e.value.includes('executor-failed')));

// --- Replan 戦略（検証失敗 → 再計画 → 成功） ---
const nbReplan85 = new CaravanNotebook('ドローン制御を実装して');
const replanExecutor85 = createAttemptArtifactHarness({ domain: 'coding', produce: (attempt) => (attempt === 1 ? 'program: [broken' : 'program: [plan=v2, lines=8]') });
const rhReplan85 = new RecoveryHarness({
  executor: replanExecutor85,
  notebook: nbReplan85,
  domain: 'coding',
  selectStrategy: (ctx) => (ctx.attempt === 1 ? { action: 'Replan', reason: 'plan が検証を満たさない', addedCapability: 'planning' } : defaultRecoveryPolicy(ctx)),
});
const resReplan85 = await runRecoveryOnce(rhReplan85, { taskId: 'replan', text: 'ドローン制御を実装して' });
check('Recovery: Replan 戦略で完了', resReplan85.ok);
check('Recovery: DECISIONS に Replan（根拠付き）', nbReplan85.entriesOf('decisions').some((e) => e.value.includes('action=Replan') && e.value.includes('plan が検証を満たさない')));

// --- AddExpert 戦略（不足能力を追加 → recoveryContext 経由で基盤に反映） ---
const nbAdd85 = new CaravanNotebook('ドローン制御を実装して');
const addExecutor85 = createAttemptArtifactHarness({
  domain: 'coding',
  produce: (attempt, task) => (attempt === 1 || !String(task.metadata?.recoveryContext ?? '').includes('addedCapability=coding') ? undefined : 'program: [plan=v3, lines=8]'),
});
const rhAdd85 = new RecoveryHarness({
  executor: addExecutor85,
  notebook: nbAdd85,
  domain: 'coding',
  selectStrategy: (ctx) => (ctx.attempt === 1 ? { action: 'AddExpert', reason: 'アーティファクトを生成できていないため能力を追加する', addedCapability: 'coding' } : defaultRecoveryPolicy(ctx)),
});
const resAdd85 = await runRecoveryOnce(rhAdd85, { taskId: 'add', text: 'ドローン制御を実装して' });
check('Recovery: AddExpert（addedCapability=coding）で完了', resAdd85.ok && resAdd85.metadata?.attempts === 2);
check('Recovery: DECISIONS に addedCapability=coding', nbAdd85.entriesOf('decisions').some((e) => e.value.includes('action=AddExpert') && e.value.includes('addedCapability=coding')));

// --- Abort 戦略（回復不能 → failed） ---
const nbAbort85 = new CaravanNotebook('ドローン制御を実装して');
const abortExecutor85 = createAttemptArtifactHarness({ domain: 'coding', produce: () => undefined });
const rhAbort85 = new RecoveryHarness({
  executor: abortExecutor85,
  notebook: nbAbort85,
  domain: 'coding',
  selectStrategy: () => ({ action: 'Abort', reason: '回復不能と判断' }),
});
let abortThrew85 = false;
try {
  await runRecoveryOnce(rhAbort85, { taskId: 'abort', text: 'ドローン制御を実装して' });
} catch (e) {
  abortThrew85 = e instanceof HarnessTaskError && e.error.code === 'RECOVERY_EXHAUSTED' && e.error.retryable === false;
}
check('Recovery: Abort → failed(RECOVERY_EXHAUSTED / non-retryable)', abortThrew85);
check('Recovery: Abort 時も根拠が DECISIONS に残る', nbAbort85.entriesOf('decisions').some((e) => e.value.includes('action=Abort')));

// --- maxAttempts 上限（既定ポリシー・毎回形式不良） ---
const nbMax85 = new CaravanNotebook('ドローン制御を実装して');
const badExecutor85 = createAttemptArtifactHarness({ domain: 'coding', produce: () => 'program: [broken' });
const rhMax85 = new RecoveryHarness({ executor: badExecutor85, notebook: nbMax85, domain: 'coding', maxAttempts: 2 });
let maxThrew85 = false;
try {
  await runRecoveryOnce(rhMax85, { taskId: 'max', text: 'ドローン制御を実装して' });
} catch (e) {
  maxThrew85 = e instanceof HarnessTaskError && e.error.code === 'RECOVERY_EXHAUSTED' && /maxAttempts=2/.test(e.error.message);
}
check('Recovery: maxAttempts=2 で停止（RECOVERY_EXHAUSTED）', maxThrew85);
check('Recovery: maxAttempts 上限で ERRORS/DECISIONS が 2 回', nbMax85.entriesOf('errors').length === 2 && nbMax85.entriesOf('decisions').length === 2);

// --- Round 予算（round-timeout → Retry） ---
const nbBudget85 = new CaravanNotebook('ドローン制御を実装して');
const slowExecutor85: Harness = {
  async *execute(task, options) {
    if (options?.signal?.aborted) throw new Error('slow: aborted');
    yield { type: 'started', taskId: task.taskId, executionId: `slow-${Date.now()}`, timestamp: Date.now() };
    await new Promise((r) => setTimeout(r, 30));
    yield { type: 'completed', taskId: task.taskId, executionId: `slow-${Date.now()}`, result: { ok: true, output: 'program: [plan=slow, lines=1]' }, timestamp: Date.now() };
  },
};
const rhBudget85 = new RecoveryHarness({ executor: slowExecutor85, notebook: nbBudget85, domain: 'coding', roundBudgetMs: 5, maxAttempts: 2 });
let budgetThrew85 = false;
try {
  await runRecoveryOnce(rhBudget85, { taskId: 'budget', text: 'ドローン制御を実装して' });
} catch (e) {
  budgetThrew85 = e instanceof HarnessTaskError && e.error.code === 'RECOVERY_EXHAUSTED';
}
check('Recovery: round-timeout で失敗（予算超過）', budgetThrew85);
check('Recovery: round-timeout が ERRORS に記録', nbBudget85.entriesOf('errors').some((e) => e.value.includes('round-timeout')));

// --- IR 制約外の成果物（外部由来の生テキスト）→ reject → 形式不良として Retry → 成功 ---
const nbIr85 = new CaravanNotebook('ドローン制御を実装して');
const irExecutor85 = createAttemptArtifactHarness({
  domain: 'coding',
  produce: (attempt) => (attempt === 1 ? 'プログラム: 生テキスト（IR ではない）' : 'program: [plan=v4, lines=8]'),
});
const rhIr85 = new RecoveryHarness({ executor: irExecutor85, notebook: nbIr85, domain: 'coding' });
const resIr85 = await runRecoveryOnce(rhIr85, { taskId: 'ir', text: 'ドローン制御を実装して' });
check('Recovery: IR 制約外の成果物 → reject → Retry → 成功', resIr85.ok && resIr85.metadata?.attempts === 2);
check('Recovery: IR 制約外が ERRORS に記録', nbIr85.entriesOf('errors').some((e) => e.value.includes('IR 形式でない')));

// --- Harness ABI 互換性（Harness として event stream を消費できる） ---
const nbAbi85 = new CaravanNotebook('ドローン制御を実装して');
const abiExecutor85 = createAttemptArtifactHarness({ domain: 'coding', produce: (attempt) => (attempt === 1 ? 'program: [broken' : 'program: [plan=v1, lines=8]') });
const rhAbi85 = new RecoveryHarness({ executor: abiExecutor85, notebook: nbAbi85, domain: 'coding' });
const events85: string[] = [];
for await (const ev of rhAbi85.execute({ taskId: 'abi', text: 'ドローン制御を実装して' })) {
  events85.push(ev.type);
}
check('Recovery: Harness ABI（started→…→completed）', events85[0] === 'started' && events85[events85.length - 1] === 'completed');
check('Recovery: 中間に message（recover[1]: …）', events85.some((t) => t === 'message'));

// verifyArtifactOnly: plan が無くてもアーティファクトがあれば ok（plan を要求しない）
const nbNoPlan85 = new CaravanNotebook('ドローン制御を実装して');
nbNoPlan85.append('analysis', 'program', 'program: [plan=none, lines=1]', 'coding', { round: 1 });
check('Recovery: verifyArtifactOnly は plan を要求しない（アーティファクトのみで ok）', verifyArtifactOnly(nbNoPlan85, 'coding').ok);
check('Recovery: verifyArtifactOnly は成果物なしで fail', !verifyArtifactOnly(new CaravanNotebook('x'), 'coding').ok);

// [86] Memory Harness（Knowledge Oasis 長期記憶 → 検索・注入・実行・記録の閉ループ。性能改善は主張しない）
console.log('\n[86] Memory Harness（Oasis 長期記憶 → 検索・注入・実行・記録の閉ループ）');
const { MemoryHarness, buildMemoryTask, formatMemory, parseInjectedMemory, createMemoryAwareExecutor, runMemoryOnce } = await import('../cognitive/memory-harness.js');
// KnowledgeOasis / makeLesson は [75] で import 済み。CaravanNotebook / RecoveryHarness / runRecoveryOnce は [81]/[85] で import 済み

// --- 純関数（決定論） ---
check('Memory: formatMemory は IR（retrieved/sources/lessons）', formatMemory({ task: 't', retrieved: 2, sources: ['a', 'b'], lessons: ['L1', 'L2'] }) === 'memory: [retrieved=2, sources=[a ; b] lessons=[L1 ; L2]]');
check('Memory: formatMemory は retrieved=0 でも IR を返す', formatMemory({ task: 't', retrieved: 0, sources: [], lessons: [] }) === 'memory: [retrieved=0, sources=[]]');
const memTask86 = buildMemoryTask({ taskId: 't1', text: 'ドローン制御を実装して' }, { task: 'x', retrieved: 1, sources: ['過去タスク'], lessons: ['LESSON: 成功パターン'] });
check('Memory: buildMemoryTask が memory context を注入', memTask86.text.includes('memory context') && parseInjectedMemory(memTask86).retrieved === 1 && parseInjectedMemory(memTask86).lessons.length === 1);
const memEmpty86 = buildMemoryTask({ taskId: 't2', text: 'ドローン制御を実装して' }, { task: 'x', retrieved: 0, sources: [], lessons: [] });
check('Memory: メモリなしのときは retrieved=0 が注入される', parseInjectedMemory(memEmpty86).retrieved === 0);

// メモリ依存の決定論 Executor: 注入メモリに retrieved>0 かつ LESSON があれば成功する
const memExec86 = createMemoryAwareExecutor({
  domain: 'coding',
  produce: (task) => {
    const m = parseInjectedMemory(task);
    return m.retrieved > 0 && m.lessons.length > 0 ? 'program: [plan=memo-v1, lines=8]' : undefined;
  },
});

// --- Oasis が空 → メモリなし → 実行失敗 → RECORD(fail) ---
const oasis86 = new KnowledgeOasis();
const nb86a = new CaravanNotebook('ドローン制御を実装して');
const mh86a = new MemoryHarness({ executor: memExec86, oasis: oasis86, notebook: nb86a });
let failThrew86 = false;
try {
  await runMemoryOnce(mh86a, { taskId: 'm1', text: 'ドローン制御を実装して' });
} catch (e) {
  failThrew86 = e instanceof HarnessTaskError && e.error.code === 'MEMORY_SCRIPTED_FAIL';
}
check('Memory: Oasis 空 → メモリなし → 実行失敗', failThrew86);
check('Memory: 失敗が Oasis に記録（recordBack）', oasis86.size === 1 && oasis86.all()[0].result === 'fail');
check('Memory: Notebook.context に memory IR（retrieved=0）', nb86a.entriesOf('context').some((e) => e.key === 'memory' && e.value.includes('retrieved=0')));

// --- 成功実績を Oasis に蓄積 → 2 回目: メモリ注入 → 成功（閉ループ） ---
oasis86.recordCaravan({
  task: 'ドローン制御を実装して', team: ['coding'], result: 'success', quality: 0.9,
  lesson: 'LESSON: ドローン制御を実装して success', confidence: 0.8, notebookSnapshot: nb86a.snapshot(),
});
const nb86b = new CaravanNotebook('ドローン制御を実装して');
const mh86b = new MemoryHarness({ executor: memExec86, oasis: oasis86, notebook: nb86b });
const res86b = await runMemoryOnce(mh86b, { taskId: 'm2', text: 'ドローン制御を実装して' });
check('Memory: 2 回目は過去実績を検索・注入して成功（閉ループ）', res86b.ok && Number(res86b.metadata?.memory) >= 1);
check('Memory: 注入メモリが metadata に反映（sources）', Array.isArray(res86b.metadata?.sources) && res86b.metadata?.sources.length >= 1);
check('Memory: 2 回目も Notebook.context に memory IR（retrieved>0）', nb86b.entriesOf('context').some((e) => e.key === 'memory' && /retrieved=[1-9]/.test(e.value)));
check('Memory: Oasis が成長（fail + 手動 success + 2 回目の記録）', oasis86.size >= 3);

// --- maxMemory 上限 / recordBack:false / Harness ABI ---
const oasis86c = new KnowledgeOasis();
for (let i = 0; i < 5; i++) oasis86c.record({ task: `類似タスク${i}`, team: [], graph: [], hypothesis: [], result: 'success', quality: 0.9, lesson: `L${i}`, confidence: 0.8, at: Date.now() });
const mh86c = new MemoryHarness({ executor: createMemoryAwareExecutor({ domain: 'coding', produce: () => 'program: [x]' }), oasis: oasis86c, maxMemory: 2 });
const res86c = await runMemoryOnce(mh86c, { taskId: 'c', text: '類似タスク' });
check('Memory: maxMemory で検索件数を上限（2）', res86c.metadata?.memory === 2);
const oasis86d = new KnowledgeOasis();
const mh86d = new MemoryHarness({ executor: createMemoryAwareExecutor({ domain: 'coding', produce: () => 'program: [x]' }), oasis: oasis86d, recordBack: false });
const res86d = await runMemoryOnce(mh86d, { taskId: 'd', text: 'ドローン制御を実装して' });
check('Memory: recordBack=false は Oasis を汚さない', res86d.ok && oasis86d.size === 0);
const events86: string[] = [];
for await (const ev of mh86b.execute({ taskId: 'abi', text: 'ドローン制御を実装して' })) events86.push(ev.type);
check('Memory: Harness ABI（started→message→completed）', events86[0] === 'started' && events86.includes('message') && events86[events86.length - 1] === 'completed');

// --- RecoveryHarness との合成（Memory が文脈供給、Recovery が検証・回復。decorator 合成可能） ---
const oasis86e = new KnowledgeOasis();
oasis86e.recordCaravan({
  task: 'ドローン制御を実装して', team: ['coding'], result: 'success', quality: 0.9,
  lesson: 'LESSON: ドローン制御を実装して success', confidence: 0.8, notebookSnapshot: nb86a.snapshot(),
});
const memInner86 = new MemoryHarness({ executor: memExec86, oasis: oasis86e });
const nb86e = new CaravanNotebook('ドローン制御を実装して');
const rh86 = new RecoveryHarness({ executor: memInner86, notebook: nb86e, domain: 'coding' });
const res86e = await runRecoveryOnce(rh86, { taskId: 'compose', text: 'ドローン制御を実装して' });
check('Memory+Recovery: Harness decorator として合成可能（閉ループ）', res86e.ok);
check('Memory+Recovery: Memory の記録が Oasis に反映', oasis86e.size >= 2 && oasis86e.all().some((e) => e.result === 'success'));

// [87] Expert Formation（Dynamic Expert Formation / Phase C）— 不足能力推定 → Pool から Expert を動的編成
console.log('\n[87] Expert Formation（不足能力推定 → Pool から Expert を動的編成）');
const { inferMissingCapability, rankCandidateExperts, defaultFormationPolicy, formationExpertFromPool, formatFormationDecision } = await import('../cognitive/expert-formation.js');
// AI_POOL は [75] で import 済み。CaravanNotebook / runCaravan / fixedCaravan は [81]/[82]、KnowledgeOasis は [75] で import 済み

// 決定論 Simulation の planning だけのチーム（program を書けない → FORM 対象）
const planningOnly87 = [{
  id: 'planning', name: 'Planning', role: 'planning',
  readSections: ['task', 'errors'] as const,
  writeSections: ['plan'] as const,
  execute: async ({ task: t }: { task: string }) => ({ ir: `plan: [steps=2, goal="${t.slice(0, 12)}"]`, ms: 20, ok: true }),
}];

// --- 純関数（決定論） ---
type FormationCtx = Parameters<typeof defaultFormationPolicy>[0];
const nbF87 = new CaravanNotebook('ドローンの制御コードを実装して');
nbF87.append('errors', 'error', 'error: "VERIFY 失敗: coding: analysis セクションに program が無い"', 'master', { round: 1 });
const mkCtx87 = (team: FormationCtx['team'], issues: FormationCtx['verification']['issues']): FormationCtx => ({
  task: 'ドローンの制御コードを実装して',
  notebook: nbF87,
  domain: 'coding',
  team,
  pool: AI_POOL,
  verification: { ok: issues.length === 0, issues },
  round: 1,
});
check('Formation: coding の不足で coding を推定', inferMissingCapability(mkCtx87([], [{ verifier: 'Artifact', message: 'coding: analysis セクションに program が無い' }])).includes('coding'));
const teamWithCoding87 = fixedCaravan('ドローンの制御コードを実装して');
check('Formation: 既に coding がいるチームは coding を除外', !inferMissingCapability(mkCtx87(teamWithCoding87, [{ verifier: 'Artifact', message: 'coding: analysis セクションに program が無い' }])).includes('coding'));
// RecoveryHarness が記録した addedCapability を DECISIONS から読む（接続点）
const nbDec87 = new CaravanNotebook('x^2=4 を解いて');
nbDec87.append('decisions', 'decision', 'decision: [action=AddExpert, addedCapability=math]', 'recovery', { round: 1 });
check('Formation: DECISIONS の addedCapability=math を推定に使う', inferMissingCapability({ task: 'x^2=4 を解いて', notebook: nbDec87, domain: 'math', team: [], pool: AI_POOL, verification: { ok: false, issues: [] }, round: 1 }).includes('math'));
const ranked87 = rankCandidateExperts(AI_POOL, ['coding', 'math'], planningOnly87);
check('Formation: 候補ランキングは coding を優先', ranked87.length >= 1 && ranked87[0].id === 'coding');
const dec87 = defaultFormationPolicy(mkCtx87([], [{ verifier: 'Artifact', message: 'coding: analysis セクションに program が無い' }]));
check('Formation: 既定ポリシーは coding を選択（Need-to-know）', dec87.expertId === 'coding' && dec87.writeSections.includes('analysis') && dec87.readSections.includes('plan'));
// 役割シグナルもドメイン要件も無いタスク → 不足能力なし → 編成しない
const nbNeutral87 = new CaravanNotebook('あいさつして');
check('Formation: 不足なしは expertId=null', defaultFormationPolicy({ task: 'あいさつして', notebook: nbNeutral87, domain: 'generic', team: [], pool: AI_POOL, verification: { ok: true, issues: [] }, round: 1 }).expertId === null);
check('Formation: formatFormationDecision は IR（expert + addedCapability）', formatFormationDecision({ expertId: 'coding', addedCapability: 'coding', reason: 'r', readSections: [], writeSections: ['analysis'] }).startsWith('decision: [action=AddExpert, expert=coding, reason="r", addedCapability=coding]'));
const formEsc87 = formatFormationDecision({ expertId: 'coding', addedCapability: 'coding', reason: 'quoted "r" [x]', readSections: [], writeSections: ['analysis'] });
check('Formation: formatFormationDecision は構造文字をサニタイズ（" / [ / ]）', formEsc87.includes('reason="quoted \\"r\\" (x)"') && !formEsc87.includes('[x]'));
const addedExpert87 = formationExpertFromPool(AI_POOL[3], { readSections: ['task', 'plan'] as const, writeSections: ['analysis'] as const });
const simRun87 = await addedExpert87.execute!({ task: 'ドローンの制御コードを実装して', round: 1, view: [] });
check('Formation: 決定論 Simulation で program IR を生成', simRun87.ok && /^program: \[/.test(simRun87.ir));

// --- runCaravan 統合: planning のみ → FORM +coding → Round 2 で成功（閉ループ） ---
const oasisF87 = new KnowledgeOasis();
const runF87 = await runCaravan({ task: 'ドローンの制御コードを実装して', team: planningOnly87, formation: defaultFormationPolicy, pool: AI_POOL, oasis: oasisF87 });
check('Formation: planning のみ → FORM +coding → 成功（閉ループ）', runF87.success && runF87.stopReason === 'verified');
check('Formation: チームが動的に拡張（+coding）', runF87.team.some((e) => e.id === 'coding') && runF87.teamKey.includes('coding'));
check('Formation: DECISIONS に AddExpert(expert=coding / addedCapability=coding) が記録', runF87.notebook.entriesOf('decisions').some((e) => e.value.includes('action=AddExpert') && e.value.includes('expert=coding') && e.value.includes('addedCapability=coding')));
check('Formation: Round に FORM ログがある', runF87.rounds.some((r) => r.phase === 'REPLAN' && r.note.includes('FORM:')));
check('Formation: Oasis に最終（拡張済み）チームが保存', oasisF87.all().some((e) => e.result === 'success' && e.team.includes('coding')));
// Formation 自身が記録した Decision IR を inferMissingCapability が再生できる（RecoveryHarness とスキーマ統一）
const nbRT87 = new CaravanNotebook('あいさつして');
nbRT87.append('decisions', 'decision', formatFormationDecision({ expertId: 'coding', addedCapability: 'coding', reason: '不足能力 "coding" を補完', readSections: ['task', 'plan'], writeSections: ['analysis'] }), 'formation', { round: 1 });
check('Formation: Formation が記録した Decision を能力推定で再生できる', inferMissingCapability({ task: 'あいさつして', notebook: nbRT87, domain: 'generic', team: [], pool: AI_POOL, verification: { ok: true, issues: [] }, round: 1 }).includes('coding'));
const runNoForm87 = await runCaravan({ task: 'ドローンの制御コードを実装して', team: planningOnly87, formation: defaultFormationPolicy, pool: AI_POOL, maxFormation: 0 });
check('Formation: maxFormation=0 なら編成しない', !runNoForm87.success && runNoForm87.team.length === 1 && runNoForm87.notebook.entriesOf('decisions').length === 0);

// [88] Caravan Cognitive E2E（Memory → Loop → Verifier → Recovery → Formation の一本通し）
console.log('\n[88] Caravan Cognitive E2E（全層一本通し）');
const { runCaravanE2E, e2eExpertFromPool, DEFAULT_TOKEN_COST, renderCaravanE2E } = await import('../cognitive/caravan-e2e.js');
const { expertIOFor } = await import('../cognitive/expert-formation.js');
// AI_POOL は [75]、CaravanNotebook は [81]、KnowledgeOasis は [75]、planningOnly87 は [87] で定義済み

// --- Full（recovery + formation）: planning のみ → FORM +coding → 成功（閉ループ） ---
const oasisE88 = new KnowledgeOasis();
const e2eFull = await runCaravanE2E({ task: 'ドローンの制御コードを実装して', pool: AI_POOL, team: planningOnly87, oasis: oasisE88, recovery: true, formation: true });
check('E2E: Full（recovery+formation）で成功', e2eFull.success && e2eFull.stopReason === 'verified');
check('E2E: formation で Expert が追加（+coding）', e2eFull.formationUsed && e2eFull.team.includes('coding'));
check('E2E: 再実行された（attempts>=2）', e2eFull.attempts >= 2);
check('E2E: RECOVERY / FORM がログに記録', e2eFull.rounds.some((r) => r.note.includes('RECOVERY:')) && e2eFull.rounds.some((r) => r.note.includes('FORM:')));
check('E2E: Oasis に成功チーム（+coding）が記録', oasisE88.all().some((e) => e.result === 'success' && e.team.includes('coding')));

// --- memory 構成: Oasis から RETRIEVE → Notebook.context に memory IR ---
const oasisE88b = new KnowledgeOasis();
oasisE88b.recordCaravan({ task: 'ドローンの制御コードを実装して', team: ['coding'], result: 'success', quality: 0.9, lesson: 'LESSON: ドローン success', confidence: 0.8, notebookSnapshot: new CaravanNotebook('x').snapshot() });
const e2eMem = await runCaravanE2E({ task: 'ドローンの制御コードを実装して', pool: AI_POOL, team: planningOnly87, oasis: oasisE88b, memory: true, formation: true });
check('E2E: memory 構成で context に memory IR（retrieved>0）', e2eMem.memoryUsed && e2eMem.notebook.entriesOf('context').some((e) => e.key === 'memory' && /retrieved=[1-9]/.test(e.value)));

// --- Abort 戦略（カスタム selectStrategy） ---
const e2eAbort = await runCaravanE2E({ task: 'ドローンの制御コードを実装して', pool: AI_POOL, team: planningOnly87, recovery: true, selectStrategy: () => ({ action: 'Abort', reason: '回復不能と判断' }) });
check('E2E: Abort 戦略で aborted', !e2eAbort.success && e2eAbort.stopReason === 'aborted');
check('E2E: Abort 時も DECISIONS に根拠が残る', e2eAbort.notebook.entriesOf('decisions').some((e) => e.value.includes('action=Abort')));

// --- 実モデル口（ModelExecutor）: fake model が呼ばれ tokens / cost が記録 ---
let modelCalls88 = 0;
const fakeModel88 = async (call: { expert: string }): Promise<{ ir: string; ok: boolean; ms: number; tokens?: number }> => {
  modelCalls88++;
  if (call.expert === 'planning') return { ir: 'plan: [steps=2, goal="model"]', ok: true, ms: 10, tokens: 50 };
  if (call.expert === 'coding') return { ir: 'program: [plan=e2e-model, lines=8]', ok: true, ms: 20, tokens: 100 };
  return { ir: 'analysis: [hits=1]', ok: true, ms: 10, tokens: 40 };
};
const modelTeam88 = [
  e2eExpertFromPool(AI_POOL[0], expertIOFor('planning'), fakeModel88),
  e2eExpertFromPool(AI_POOL[3], expertIOFor('coding'), fakeModel88),
];
const e2eModel = await runCaravanE2E({ task: 'ドローンの制御コードを実装して', pool: AI_POOL, team: modelTeam88 });
check('E2E: model 接続で成功（model が呼ばれる）', e2eModel.success && modelCalls88 >= 2);
check('E2E: tokens が記録される', e2eModel.tokens > 0);
check('E2E: コストが tokens × 単価で計算', e2eModel.cost === e2eModel.tokens * DEFAULT_TOKEN_COST);

// --- composeTeam 自動編成（team 未指定） ---
const e2eAuto = await runCaravanE2E({ task: 'ドローンの制御コードを実装して', pool: AI_POOL });
check('E2E: composeTeam 自動編成で成功', e2eAuto.success && e2eAuto.team.length >= 2);

// --- ベース構成（何も有効化しない）: Ablation の対照（program なし → 失敗） ---
const e2eBase = await runCaravanE2E({ task: 'ドローンの制御コードを実装して', pool: AI_POOL, team: planningOnly87 });
check('E2E: ベース構成（無効化）は失敗する（Ablation の対照）', !e2eBase.success && e2eBase.stopReason === 'max-attempts');
check('E2E: renderCaravanE2E が表示文字列を返す', renderCaravanE2E(e2eFull).length > 0);

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — AILSM Phase 0.5（Stage 1 決定論 + Stage 3 決定論Verifier）');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
}

main();
