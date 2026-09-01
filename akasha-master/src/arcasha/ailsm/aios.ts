/**
 * AI OS Init（Phase 1.2）— Hub（demo-web.ts）を AI OS 本体にする
 *
 *   boot（DeviceTree + Kernel + Mock ドライバ）
 *     + ModelClient（実デバイス Qwen/Phi/Gemma）
 *     + RemoteDriver（実LLM）
 *     + DeviceTree（Mac / iPhone / iPad 登録）
 *     + CapabilityLearner（ODAR オンライン学習）
 *
 *   aiosExecute: テキスト → コンパイル → CALL → 実デバイス委譲 → 結果を学習に記録
 *   aiosRelay:   Planner → Math → Search → Reasoning → Planner を AILSA でリレー
 */

import { boot, execute } from './expert-runtime.js';
import type { BootResult, ExpertExecution } from './expert-runtime.js';
import { RemoteDriver } from './remote-driver.js';
import { MockModelClient } from './model-client.js';
import type { ModelClient } from './model-client.js';
import { registerHubDevices, routeCall } from './device-router.js';
import { CapabilityLearner } from './learning.js';
import { runRelay } from './relay.js';
import type { RelayResult, RelayStep } from './relay.js';
import type { ExpertDriver } from './driver.js';
import { AilsmError } from './compiler.js';
import type { CompileResult } from './compiler.js';
import type { RuntimeTrace } from './runtime.js';
import { Opcode } from '../ailsa/opcode.js';
import { Slot } from '../ailsa/vocab.js';
import type { Instruction } from '../ailsa/encoder.js';
import { ABI_VERSION_1_0 } from './abi.js';

const REMOTE_MAX_TOKENS = 64;

export interface AiOs {
  booted: BootResult;
  client: ModelClient;
  learner: CapabilityLearner;
  remoteDrivers: Map<string, RemoteDriver>; // deviceId → 実LLMドライバ
}

/** AI OS を起動する（実デバイスがあれば自動登録 + RemoteDriver を用意） */
export function initAiOs(client?: ModelClient): AiOs {
  const c = client ?? new MockModelClient();
  const booted = boot();
  const remoteDrivers = new Map<string, RemoteDriver>();
  const aios: AiOs = { booted, client: c, learner: new CapabilityLearner(), remoteDrivers };
  syncAiOs(aios);
  return aios;
}

/**
 * 現在接続中の実デバイスを AI OS に同期する（遅延登録）。
 * 起動後にデバイスが接続しても、呼び出し時に RemoteDriver + DeviceTree へ反映される。
 */
export function syncAiOs(aios: AiOs): void {
  const nodes = aios.client.listNodes();
  if (nodes.length === 0) return;
  registerHubDevices(aios.booted.deviceTree, nodes);
  for (const n of nodes) {
    if (!aios.remoteDrivers.has(n.nodeId)) {
      aios.remoteDrivers.set(
        n.nodeId,
        new RemoteDriver(`remote:${n.nodeId}`, `Qwen@${n.nodeId}`, aios.client, {
          deviceId: n.nodeId,
          maxTokens: REMOTE_MAX_TOKENS,
        }),
      );
    }
  }
}

/** deviceId に応じたドライバ（RemoteDriver を遅延生成して返す） */
function driverFor(aios: AiOs, target: string | null, expert: string): ExpertDriver | undefined {
  if (target) {
    syncAiOs(aios);
    const rd = aios.remoteDrivers.get(target);
    if (rd) return rd;
  }
  return aios.booted.drivers.get(expert);
}

export interface AiosExecution extends ExpertExecution {
  deviceId: string | null;
  learned: boolean;
  fallback?: boolean; // true = Stage-2 フォールバック（決定論コンパイラが解釈できず実機LLMへ委譲）
}

/**
 * Stage-2 フォールバック: 決定論コンパイラが解釈できないタスク（AilsmError）は
 * 400 にせず、生の CALL として実機 LLM（general）へ委譲する。
 * →「既存AIにできるタスクの全てを任せられる」ための一般フォールバック。
 */
async function fallbackExecute(
  aios: AiOs,
  text: string,
  target: string | null,
  cause: AilsmError,
): Promise<AiosExecution> {
  const { booted } = aios;
  const rawProgram: Instruction[] = [
    { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'general' }, { slot: Slot.INPUT, value: text }] },
  ];
  const driver = driverFor(aios, target, 'general') ?? booted.drivers.get('general');
  if (!driver) throw cause;
  const t0 = Date.now();
  const resp = await driver.invoke({ program: rawProgram, abiVersion: ABI_VERSION_1_0 });
  const ms = Date.now() - t0;
  const compile = { instructions: rawProgram } as unknown as CompileResult;
  const trace = {
    text,
    graph: { nodes: [], edges: [] },
    steps: [
      { kind: 'input', label: `Input: ${text.slice(0, 30)}` },
      { kind: 'compile', label: `Compile: Stage-2 フォールバック（${cause.message.slice(0, 24)}）` },
      { kind: 'call', label: 'CALL general（Stage-2 委譲）' },
      { kind: 'wait', label: 'awaiting expert result' },
    ],
    events: [],
    needsExpert: true,
    resolvedValue: null,
  } as unknown as RuntimeTrace;
  return {
    text,
    compile,
    trace,
    driverId: driver.id,
    driverResponse: resp,
    finalGraph: { nodes: [], edges: [] },
    result: resp.ok ? resp.result ?? null : null,
    ms,
    deviceId: target ?? null,
    learned: true,
    fallback: true,
  };
}

/**
 * AI OS でタスクを実行。CALL は実デバイス（RemoteDriver）へ委譲され、
 * 実実行の観測（latency / 成功）を CapabilityLearner が学習する。
 * 決定論コンパイラが解釈できないタスクは Stage-2 フォールバックで実機LLMへ委譲。
 *
 * opts.forceDelegate=true のときは、ローカル解決が可能と判定されたタスクでも
 * 必ず実機LLM（general）へ委譲する。これは公平な API 比較ベンチのため
 * （同じ問題を同じモデルで解かせる）に使う。
 * opts.maxTokens を指定すると、委譲先 RemoteDriver の生成上限を変更する
 * （デフォルト 64 のままだと長い回答が途中で切れるため、ベンチでは baseline と揃える）。
 */
export async function aiosExecute(
  aios: AiOs,
  text: string,
  deviceId?: string,
  opts?: { forceDelegate?: boolean; maxTokens?: number },
): Promise<AiosExecution> {
  syncAiOs(aios); // 現在接続中の実機を DeviceTree / RemoteDriver へ反映してからルーティング
  const { booted, client } = aios;
  const nodes = client.listNodes();
  const target = deviceId ?? routeCall(booted.deviceTree, nodes.length > 0 ? nodes[0].nodeId : undefined);
  // maxTokens 指定時は、そのデバイスの RemoteDriver を指定上限で作り直す
  if (opts?.maxTokens && target && aios.remoteDrivers.has(target)) {
    aios.remoteDrivers.set(
      target,
      new RemoteDriver(`remote:${target}`, `Qwen@${target}`, aios.client, {
        deviceId: target,
        maxTokens: opts.maxTokens,
      }),
    );
  }
  const resolver = (expert: string): ExpertDriver | undefined => driverFor(aios, target, expert);
  let ex: AiosExecution;
  if (opts?.forceDelegate) {
    // forceDelegate は「必ず実機 LLM へ委譲して同じ問題を同じモデルで解かせる」ことが意図。
    // 先に execute() を走らせると、ルーティング先エキスパートが RemoteDriver 経由で
    // 実モデルを 1 回呼んだ上で、fallbackExecute が再び呼ぶ = 二重呼び出しになる
    // （ベンチ実測: 12% のタスクで空/同一プロンプトの無駄な 2 回目が発生・+数百 ms）。
    // そのため forceDelegate 時は execute() をスキップして直接委譲する（1 回だけの呼び出し）。
    ex = await fallbackExecute(aios, text, target, new AilsmError('forced delegate (benchmark)'));
  } else {
    try {
      const base = await execute(text, booted, resolver);
      // ローカル解決に失敗した場合（ドライバ未使用 & resolvedValue なし）も委譲する。
      // 例: 「バナナ3本とりんご2個…合計は？」は math と解釈されるが、
      //     決定論コンパイラが値を出せない → そのまま null を返すのではなく
      //     実機 LLM（general）へ Stage-2 フォールバックして回答させる。
      const localFailed =
        base.driverId === null &&
        (base.trace.resolvedValue === null || base.trace.resolvedValue === undefined);
      if (localFailed) {
        ex = await fallbackExecute(aios, text, target, new AilsmError('local resolution failed: no value'));
      } else {
        ex = { ...base, deviceId: target ?? null, learned: base.driverId !== null, fallback: false };
      }
    } catch (e) {
      if (!(e instanceof AilsmError)) throw e;
      ex = await fallbackExecute(aios, text, target, e);
    }
  }
  if (ex.driverId && ex.driverResponse) {
    const dev = target ? booted.deviceTree.node(target) : undefined;
    aios.learner.observe(ex.driverId, {
      accuracy: ex.driverResponse.ok ? 0.9 : 0.1,
      latencyMs: Math.max(1, ex.ms),
      cost: 0.1,
      success: ex.driverResponse.ok,
      battery: dev?.battery !== undefined ? dev.battery / 100 : undefined,
      gpu: dev?.features?.gpuUsage !== undefined ? Number(dev.features.gpuUsage) : undefined,
    });
  }
  return ex;
}

/** 複数 Expert を AILSA でリレー（実デバイスへ委譲可能） */
export async function aiosRelay(aios: AiOs, steps: RelayStep[], deviceId?: string): Promise<RelayResult> {
  syncAiOs(aios); // 現在接続中の実機を反映
  const { booted } = aios;
  const target = deviceId ?? routeCall(booted.deviceTree);
  const resolver = (expert: string): ExpertDriver | undefined => driverFor(aios, target, expert);
  return runRelay(booted, steps, resolver);
}

/** AI OS の状態表示（aiperf 風） */
export function renderAiOs(aios: AiOs): string {
  const lines: string[] = ['=== AI OS ==='];
  lines.push('DeviceTree:');
  lines.push(aios.booted.deviceTree.describe().split('\n').map((l) => '  ' + l).join('\n'));
  lines.push(`Learner    : ${aios.learner.all().length} expert(s) 学習済み`);
  for (const c of aios.learner.all()) {
    lines.push(`  ${c.expert.padEnd(16)} acc=${c.accuracy.toFixed(2)} lat=${c.latencyMs.toFixed(1)}ms cost=${c.cost.toFixed(2)} n=${c.samples}`);
  }
  return lines.join('\n');
}
