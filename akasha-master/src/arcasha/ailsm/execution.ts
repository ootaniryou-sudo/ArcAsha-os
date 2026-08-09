/**
 * Execution Context SSA（Phase 0.21）— AI の「思考途中」を保存するプロセスコンテキスト
 *
 * CPU の Process Context に相当する。Long Context を読む Expert は
 *   current page / current hypothesis / temporary variables / call stack / active experts / cache
 * を Execution Context に保持しながら、必要ページだけを読む。
 *
 *   Context → Execution Context → Belief → Memory → Reflection
 *
 * 「Page1 で A だと思った → Page100 で B → Page300 で C」という思考途中の遷移を
 * どこへ保存するか、という問題の答えが Execution Context である。
 *
 * Context Switch: Expert 切り替え時に save() / restore() する（AI Thread が本物の Thread になる）。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export type ExecutionState = 'created' | 'ready' | 'running' | 'suspended' | 'finished';

export interface ExecutionContext {
  id: number;
  contextId: number;
  owner: string; // process / thread
  expert: string; // 現在の専門
  state: ExecutionState;
  currentPage: number | null;
  currentChunk: number | null; // ページ内のチャンク（途中再開用）
  currentSpan: number | null; // チャンク内のスパン（途中再開用）
  cursor: number; // トークン位置（Cursor — 途中から再開できる）
  attention: string[]; // 注目ノード（Equation#5 等 — Attention）
  hypothesis: string; // 現在の仮説（思考途中）
  vars: string[]; // 一時変数
  callStack: string[]; // Expert 呼び出し履歴
  activeExperts: string[];
  residentPages: number[]; // ロード済みページ（resident set）
  stack: number[]; // Reasoning Stack（推論フレーム ID 列）
}

export type FrameState = 'active' | 'suspended' | 'merged' | 'popped';

const VALID_EXEC_STATES: readonly ExecutionState[] = ['created', 'ready', 'running', 'suspended', 'finished'];
const VALID_FRAME_STATES: readonly FrameState[] = ['active', 'suspended', 'merged', 'popped'];

/** 不正な ExecutionState を拒否（属性の破損・不正バイト列からの防御） */
function isExecState(v: unknown): v is ExecutionState {
  return typeof v === 'string' && (VALID_EXEC_STATES as readonly string[]).includes(v);
}

/** 不正な FrameState を拒否（同上） */
function isFrameState(v: unknown): v is FrameState {
  return typeof v === 'string' && (VALID_FRAME_STATES as readonly string[]).includes(v);
}

export interface ReasoningFrame {
  id: number;
  label: string; // 'branchA' | 'branchB' 等
  hypothesis: string;
  state: FrameState;
}

export interface ExecutionResult {
  graph: AilsmGraph;
  exec: ExecutionContext;
}

export interface SwitchEvent {
  kind: 'SAVE' | 'RESTORE' | 'SWITCH';
  from?: string;
  to?: string;
  detail: string;
}

function toExec(g: AilsmGraph, id: number): ExecutionContext | undefined {
  const n = g.nodes.find((x) => x.id === id && x.kind === 'execution');
  if (!n) return undefined;
  const cp = n.attrs.currentPage;
  const cc = n.attrs.currentChunk;
  const cs = n.attrs.currentSpan;
  return {
    id: n.id,
    contextId: typeof n.attrs.contextId === 'number' ? n.attrs.contextId : Number(n.attrs.contextId ?? 0),
    owner: String(n.attrs.owner ?? ''),
    expert: String(n.attrs.expert ?? ''),
    state: isExecState(n.attrs.state) ? n.attrs.state : 'created',
    currentPage: cp === undefined || cp === 0 ? null : Number(cp),
    currentChunk: cc === undefined || cc === 0 ? null : Number(cc),
    currentSpan: cs === undefined || cs === 0 ? null : Number(cs),
    cursor: Number(n.attrs.cursor ?? 0),
    attention: (n.attrs.attention as string[] | undefined) ?? [],
    hypothesis: String(n.attrs.hypothesis ?? ''),
    vars: (n.attrs.vars as string[] | undefined) ?? [],
    callStack: (n.attrs.callStack as string[] | undefined) ?? [],
    activeExperts: (n.attrs.activeExperts as string[] | undefined) ?? [],
    residentPages: ((n.attrs.residentPages as string[] | undefined) ?? []).map(Number),
    stack: ((n.attrs.stack as string[] | undefined) ?? []).map(Number),
  };
}

function toFrame(g: AilsmGraph, id: number): ReasoningFrame | undefined {
  const n = g.nodes.find((x) => x.id === id && x.kind === 'frame');
  if (!n) return undefined;
  return {
    id: n.id,
    label: String(n.attrs.label ?? ''),
    hypothesis: String(n.attrs.hypothesis ?? ''),
    state: isFrameState(n.attrs.state) ? n.attrs.state : 'active',
  };
}

/** 複数ノードを in-place で属性更新したグラフを返す（ID は不変） */
function rebuildWithOverrides(
  g: AilsmGraph,
  overrides: Map<number, Record<string, string | number | boolean | string[]>>,
): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const ov = overrides.get(n.id);
    const id = b.addNode(n.kind, n.label, n.type, ov ? { ...n.attrs, ...ov } : n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

function rebuild(g: AilsmGraph, fn: (b: AilsmBuilder, remap: Map<number, number>) => void): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  fn(b, remap);
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

/** Execution Context#N を作成（context `contains` execution） */
export function createExecutionContext(
  g: AilsmGraph,
  contextId: number,
  owner: string,
  expert: string,
): ExecutionResult {
  let createdId = 0;
  const graph = rebuild(g, (b, remap) => {
    createdId = b.addNode('execution', `${owner}:${expert}`, 'unknown', {
      contextId,
      owner,
      expert,
      state: 'created',
      currentPage: 0,
      currentChunk: 0,
      currentSpan: 0,
      cursor: 0,
      attention: [],
      hypothesis: '',
      vars: [],
      callStack: [],
      activeExperts: [expert],
      residentPages: [],
      stack: [],
    });
    const ctx = remap.get(contextId);
    if (ctx !== undefined && ctx !== createdId) b.connect(ctx, createdId, 'contains');
  });
  return { graph, exec: toExec(graph, createdId)! };
}

export function executionOf(g: AilsmGraph, execId: number): ExecutionContext | undefined {
  return toExec(g, execId);
}

/** Execution Context を更新（currentPage / hypothesis / vars / callStack / residentPages 等） */
export function updateExecution(
  g: AilsmGraph,
  execId: number,
  patch: Partial<Omit<ExecutionContext, 'id' | 'contextId'>>,
): ExecutionResult {
  const cur = toExec(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  const merged: ExecutionContext = { ...cur, ...patch };
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    if (n.id === execId) {
      const id = b.addNode('execution', `${merged.owner}:${merged.expert}`, 'unknown', {
        contextId: merged.contextId,
        owner: merged.owner,
        expert: merged.expert,
        state: merged.state,
        currentPage: merged.currentPage ?? 0,
        currentChunk: merged.currentChunk ?? 0,
        currentSpan: merged.currentSpan ?? 0,
        cursor: merged.cursor,
        attention: merged.attention,
        hypothesis: merged.hypothesis,
        vars: merged.vars,
        callStack: merged.callStack,
        activeExperts: merged.activeExperts,
        residentPages: merged.residentPages.map(String),
        stack: merged.stack.map(String),
      }, n.constraints);
      remap.set(n.id, id);
    } else {
      const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
      remap.set(n.id, id);
    }
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), exec: toExec(b.graph(), execId)! };
}

/** Context Switch OUT: 思考途中を保存して suspend */
export function saveExecutionContext(g: AilsmGraph, execId: number): ExecutionResult {
  return updateExecution(g, execId, { state: 'suspended' });
}

/** Context Switch IN: 保存済みの思考途中を復元して running */
export function restoreExecutionContext(g: AilsmGraph, execId: number): ExecutionResult {
  return updateExecution(g, execId, { state: 'running' });
}

/** Context Switch: from を save → to を restore（CPU のコンテキストスイッチに相当） */
export function contextSwitch(
  g: AilsmGraph,
  fromExecId: number,
  toExecId: number,
): { graph: AilsmGraph; events: SwitchEvent[] } {
  const from = toExec(g, fromExecId);
  const to = toExec(g, toExecId);
  if (!from || !to) throw new Error('Context Switch: Execution がありません');
  const events: SwitchEvent[] = [];
  let graph = g;
  const saved = saveExecutionContext(graph, fromExecId);
  graph = saved.graph;
  events.push({ kind: 'SAVE', from: from.expert, detail: `${from.expert} の思考途中を保存（仮説: ${from.hypothesis || '空'}）` });
  const restored = restoreExecutionContext(graph, toExecId);
  graph = restored.graph;
  events.push({ kind: 'RESTORE', to: to.expert, detail: `${to.expert} の思考途中を復元` });
  events.push({ kind: 'SWITCH', from: from.expert, to: to.expert, detail: `${from.expert} → ${to.expert}` });
  return { graph, events };
}

/** 思考途中を Memory に保存（execution `stores` memory） */
export function commitMemory(
  g: AilsmGraph,
  execId: number,
  key: string,
  value: string,
): { graph: AilsmGraph; memoryId: number } {
  const cur = toExec(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  let memoryId = 0;
  const graph = rebuild(g, (b, remap) => {
    memoryId = b.addNode('memory', key, 'string', { key, value });
    const ex = remap.get(execId);
    if (ex !== undefined && ex !== memoryId) b.connect(ex, memoryId, 'stores');
  });
  return { graph, memoryId };
}

/**
 * Reasoning Stack（Phase 0.22）— 複数の推論（branch A / branch B）を同時進行させる
 *
 *   Execution Context
 *     ├─ Frame1（branchA）
 *     ├─ Frame2（branchB）
 *     └─ ...
 *
 * if → branch A / branch B を両方進め、最後に Reflection → merge する。
 */

/** 推論フレームを push（execution `contains` frame + stack に追加） */
export function pushFrame(
  g: AilsmGraph,
  execId: number,
  label: string,
  hypothesis: string,
): { graph: AilsmGraph; frame: ReasoningFrame } {
  const cur = toExec(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  let frameId = 0;
  const g1 = rebuild(g, (b, remap) => {
    frameId = b.addNode('frame', label, 'unknown', { exec: execId, label, hypothesis, state: 'active' });
    const ex = remap.get(execId);
    if (ex !== undefined && ex !== frameId) b.connect(ex, frameId, 'contains');
  });
  const g2 = updateExecution(g1, execId, { stack: [...cur.stack, frameId] });
  return { graph: g2.graph, frame: toFrame(g2.graph, frameId)! };
}

/** 最上位フレームを pop（state=popped + stack から除去） */
export function popFrame(
  g: AilsmGraph,
  execId: number,
): { graph: AilsmGraph; frame: ReasoningFrame | undefined } {
  const cur = toExec(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  if (cur.stack.length === 0) return { graph: g, frame: undefined };
  const topId = cur.stack[cur.stack.length - 1];
  const rest = cur.stack.slice(0, -1);
  const frame = toFrame(g, topId);
  const overrides = new Map<number, Record<string, string | number | boolean | string[]>>();
  overrides.set(execId, { stack: rest.map(String) });
  if (frame) overrides.set(topId, { state: 'popped' });
  return { graph: rebuildWithOverrides(g, overrides), frame: frame ? { ...frame, state: 'popped' } : undefined };
}

/** スタック上の全フレームを merge（state=merged + stack クリア + 仮説統合） */
export function mergeFrames(
  g: AilsmGraph,
  execId: number,
  mergedHypothesis: string,
): { graph: AilsmGraph; merged: number[] } {
  const cur = toExec(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  const merged = [...cur.stack];
  const overrides = new Map<number, Record<string, string | number | boolean | string[]>>();
  overrides.set(execId, { hypothesis: mergedHypothesis, stack: [] });
  for (const id of merged) overrides.set(id, { state: 'merged' });
  return { graph: rebuildWithOverrides(g, overrides), merged };
}

/** フレームを参照 */
export function frameOf(g: AilsmGraph, frameId: number): ReasoningFrame | undefined {
  return toFrame(g, frameId);
}
