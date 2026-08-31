/**
 * AI Virtual Memory（Phase 0.20）— Context / Page / Slice / Cache / Long Context ABI の統合
 *
 *   入力(500ページPDF)
 *     → Context Object（そのまま持たない）
 *     → 固定サイズ Page（Page Manager）
 *     → Slice Loader（Expert ごとに必要なページだけ）
 *     → Long Context ABI（ContextRef: 実体ではなく参照）
 *     → Expert（実体は Kernel が保持）→ Context Cache（AST/Equation を再利用）
 *
 * 既存 LLM の「コンテキストウィンドウを拡大する」設計ではなく、
 * 「AI OS が巨大な知識空間を仮想メモリとして管理し、必要な部分だけを供給する」設計。
 */

import type { AilsmGraph } from './ailsm.js';
import { createContext, contextOf, pagesOf } from './context.js';
import type { ContextObject } from './context.js';
import { DEFAULT_PAGE_SIZE } from './context.js';
import { selectPages, hasEquation } from './slice.js';
import type { ExpertKind } from './slice.js';
import { cacheArtifact, getCached } from './cache.js';
import type { CacheKind } from './cache.js';
import { buildContextArgument } from './abi.js';
import type { ContextRef } from './abi.js';
import { createExecutionContext, contextSwitch, commitMemory, updateExecution, executionOf, pushFrame, mergeFrames } from './execution.js';
import type { ExecutionContext } from './execution.js';
import { contextFault, prefetch } from './demand-paging.js';
import { subdivideContext } from './chunk.js';
import { ContextTlb, translateSpan } from './context-tlb.js';
import { TierManager } from './tier.js';
import type { TierCounts } from './tier.js';

export interface SliceLoad {
  contextId: number;
  sliceId: number;
  expert: ExpertKind;
  pageIds: number[];
  loadedText: string; // 実際に Expert へ供給するテキスト（数ページだけ）
  ref: ContextRef; // Long Context ABI: 参照
  argument: ReturnType<typeof buildContextArgument>; // ABI 引数（type=context）
}

export interface AvmStats {
  context: ContextObject;
  totalPages: number;
  totalChars: number;
  loadedPages: number;
  loadedChars: number;
  loadedRatio: number; // 全知識のうち Expert へ供給した割合（< 1 が理想）
}

export interface StoreResult {
  graph: AilsmGraph;
  context: ContextObject;
}

/** Layer 1+2: Context Object をページ分割して Memory 空間へ置く */
export function storeContext(
  g: AilsmGraph,
  title: string,
  text: string,
  pageSize = DEFAULT_PAGE_SIZE,
  overlap = 0,
): StoreResult {
  const created = createContext(g, title, text, pageSize, overlap);
  const context = contextOf(created.graph, created.contextId);
  if (!context) throw new Error('AVM: context を作成できませんでした');
  return { graph: created.graph, context };
}

export interface SliceRequestResult {
  graph: AilsmGraph;
  load: SliceLoad;
  stats: AvmStats;
}

/** Layer 3: Expert ごとに必要なページだけをロード（Slice Loader） */
export function requestSlice(
  g: AilsmGraph,
  contextId: number,
  expert: ExpertKind,
  query = '',
): SliceRequestResult {
  const sliced = selectPages(g, contextId, expert, query);
  const context = contextOf(sliced.graph, contextId);
  if (!context) throw new Error('AVM: context がありません');
  const allPages = pagesOf(sliced.graph, contextId);
  const loaded = allPages.filter((p) => sliced.pageIds.includes(p.id));
  const loadedText = loaded.map((p) => p.text).join('\n');
  const ref: ContextRef = { contextId, pageIds: sliced.pageIds, sliceId: sliced.sliceId };
  const argument = buildContextArgument(0, ref);
  return {
    graph: sliced.graph,
    load: {
      contextId,
      sliceId: sliced.sliceId,
      expert,
      pageIds: sliced.pageIds,
      loadedText,
      ref,
      argument,
    },
    stats: {
      context,
      totalPages: allPages.length,
      totalChars: context.text.length,
      loadedPages: loaded.length,
      loadedChars: loadedText.length,
      loadedRatio: context.text.length > 0 ? loadedText.length / context.text.length : 0,
    },
  };
}

export interface AvmCacheResult {
  graph: AilsmGraph;
  hit: boolean;
  value: string | null;
}

/** Layer 5: 解析結果をキャッシュ。2回目以降は再解析不要 */
export function cacheResult(
  g: AilsmGraph,
  contextId: number,
  kind: CacheKind,
  key: string,
  value: string,
): AvmCacheResult {
  const existing = getCached(g, contextId, kind, key);
  if (existing !== undefined) {
    return { graph: g, hit: true, value: existing };
  }
  const res = cacheArtifact(g, contextId, kind, key, value);
  return { graph: res.graph, hit: res.hit, value };
}

export interface DemoExpertResult {
  expert: ExpertKind;
  driverId: string;
  driverResult: string | number | null;
  slice: SliceLoad;
  stats: AvmStats;
  cacheHit: boolean;
  cacheValue: string | null;
}

export interface AvmDemoResult {
  graph: AilsmGraph;
  contextId: number;
  results: DemoExpertResult[];
  totalChars: number;
  maxLoadedRatio: number; // 全 Expert 中の最大供給割合
}

/**
 * AVM デモ: 巨大な知識空間（長文）を 2 つの Expert（math / search / planning）が
 * 必要なページだけ読んで処理する。
 */
export function runAvmDemo(): AvmDemoResult {
  const text = [
    'これはAI仮想記憶の概要ノート。本稿ではContext ObjectをOSが管理する方式を提案し、ページングとスライスにより必要な知識だけを供給する。',
    'まず式x^2+2x+1=0を考える。これは(x+1)^2=0と因数分解でき、解はx=-1である。次に積分∫x dx=(1/2)x^2+Cを確認する。',
    'ここでは導関数d/dx(x^3)=3x^2を計算する。また行列の固有値はλ^2-5λ+6=0を満たす。',
    '検索結果: arXivの論文は巨大な知識空間を扱う。referenceはdoc1であり、doc2はContext Pagingに関する研究である。',
    '検索結果: doc3はSlice Loaderの実装、doc4はContext Cacheの評価である。',
    'まとめ: 要約すると、AI OSは全ての入力をモデルに投げるのではなく、仮想メモリとして管理し必要部分だけをExpertへ供給する。',
  ].join('\n');

  let g = createContext({ nodes: [], edges: [] }, 'AI-VM研究ノート', text, DEFAULT_PAGE_SIZE).graph;
  const context = contextOf(g, 1);
  if (!context) throw new Error('AVM: コンテキスト初期化に失敗');
  const contextId = context.id;
  const results: DemoExpertResult[] = [];

  // Math Expert: 数式ページだけを読む
  const m = requestSlice(g, contextId, 'math');
  g = m.graph;
  const mCached = getCached(g, contextId, 'equation', 'parsed');
  const mRes = mCached !== undefined
    ? { graph: g, hit: true, value: mCached }
    : cacheResult(g, contextId, 'equation', 'parsed', m.load.loadedText);
  g = mRes.graph;
  results.push({
    expert: 'math',
    driverId: 'math',
    driverResult: m.load.loadedText,
    slice: m.load,
    stats: m.stats,
    cacheHit: mRes.hit,
    cacheValue: mRes.value,
  });

  // Search Expert: 検索語を含むページだけを読む
  const s = requestSlice(g, contextId, 'search', '検索結果');
  g = s.graph;
  results.push({
    expert: 'search',
    driverId: 'search',
    driverResult: s.load.loadedText,
    slice: s.load,
    stats: s.stats,
    cacheHit: false,
    cacheValue: null,
  });

  // Planning Expert: 概要（先頭 + 要約）だけを読む
  const p = requestSlice(g, contextId, 'planning');
  g = p.graph;
  const pCached = getCached(g, contextId, 'summary', 'overview');
  const pRes = pCached !== undefined
    ? { graph: g, hit: true, value: pCached }
    : cacheResult(g, contextId, 'summary', 'overview', p.load.loadedText);
  g = pRes.graph;
  results.push({
    expert: 'planning',
    driverId: 'planning',
    driverResult: pRes.value,
    slice: p.load,
    stats: p.stats,
    cacheHit: pRes.hit,
    cacheValue: pRes.value,
  });

  return {
    graph: g,
    contextId,
    results,
    totalChars: context.text.length,
    maxLoadedRatio: results.length > 0 ? Math.max(...results.map((r) => r.stats.loadedRatio)) : 0,
  };
}

export interface ExecutionDemoEvent {
  kind: 'READ' | 'FAULT' | 'PREFETCH' | 'SWITCH' | 'HYPOTHESIS' | 'MEMORY';
  detail: string;
}

export interface ExecutionDemoResult {
  graph: AilsmGraph;
  contextId: number;
  events: ExecutionDemoEvent[];
  planner: ExecutionContext;
  math: ExecutionContext;
  faults: number;
  switches: number;
  prefetched: number;
  finalHypothesis: string;
}

/**
 * Execution Context デモ（Phase 0.21）:
 * Planner が概要を読み（仮説A）→ Math へ Context Switch → 数式ページを
 * Demand Paging（Context Fault）で Kernel ロード → 隣接ページを Prefetch
 * → Planner へ復帰して仮説B に更新 → Memory へ保存。
 *
 * 「100万Token読む」のではなく「Execution Context を維持しながら必要ページだけ読む」。
 */
export function runExecutionDemo(): ExecutionDemoResult {
  const text = [
    'これはAI仮想記憶の概要ノート。本稿ではContext ObjectをOSが管理する方式を提案し、ページングとスライスにより必要な知識だけを供給する。',
    'まず式x^2+2x+1=0を考える。これは(x+1)^2=0と因数分解でき、解はx=-1である。次に積分∫x dx=(1/2)x^2+Cを確認する。',
    'ここでは導関数d/dx(x^3)=3x^2を計算する。また行列の固有値はλ^2-5λ+6=0を満たす。',
    '検索結果: arXivの論文は巨大な知識空間を扱う。referenceはdoc1であり、doc2はContext Pagingに関する研究である。',
    'まとめ: 要約すると、AI OSは全ての入力をモデルに投げるのではなく、仮想メモリとして管理し必要部分だけをExpertへ供給する。',
  ].join('\n');

  let g = createContext({ nodes: [], edges: [] }, 'EC研究ノート', text, DEFAULT_PAGE_SIZE).graph;
  const context = contextOf(g, 1);
  if (!context) throw new Error('AVM: コンテキスト初期化に失敗');
  const contextId = context.id;
  const pages = pagesOf(g, contextId);
  const events: ExecutionDemoEvent[] = [];
  let faults = 0;
  let switches = 0;
  let prefetchedTotal = 0;

  // 1. Planner Execution Context を作成
  const plannerCreated = createExecutionContext(g, contextId, 'proc1', 'planning');
  g = plannerCreated.graph;
  const plannerId = plannerCreated.exec.id;

  // 2. Planner が概要ページを読む（仮説A）→ Demand Paging（フォールト）
  const p0 = contextFault(g, plannerId, pages[0].id);
  g = p0.graph;
  if (p0.faulted) faults++;
  events.push({ kind: 'READ', detail: `planning: Page${pages[0].id} を読む（fault=${p0.faulted}）` });
  const hA = updateExecution(g, plannerId, { hypothesis: 'A: 概要を確認した' });
  g = hA.graph;
  events.push({ kind: 'HYPOTHESIS', detail: 'planning 仮説 A' });

  // 3. Math Execution Context を作成し Context Switch（planning save → math restore）
  const mathCreated = createExecutionContext(g, contextId, 'proc1', 'math');
  g = mathCreated.graph;
  const mathId = mathCreated.exec.id;
  const sw = contextSwitch(g, plannerId, mathId);
  g = sw.graph;
  switches++;
  for (const ev of sw.events) events.push({ kind: 'SWITCH', detail: ev.detail });

  // 4. Math が数式ページを要求 → 未ロードなら Context Fault → Kernel ロード
  const eqPage = pages.find((p) => hasEquation(p.text));
  if (eqPage) {
    const f = contextFault(g, mathId, eqPage.id);
    g = f.graph;
    if (f.faulted) faults++;
    events.push({
      kind: 'FAULT',
      detail: `math: Page${eqPage.id} へ Context Fault → Kernel がロード（${f.loaded.length}文字）`,
    });
    const vars = updateExecution(g, mathId, { vars: ['x=-1'], hypothesis: 'x=-1 を導出' });
    g = vars.graph;
  }

  // 5. Prefetch: 現在ページの隣接ページを先読み
  const pf = prefetch(g, mathId, 1);
  g = pf.graph;
  prefetchedTotal += pf.prefetched.length;
  events.push({ kind: 'PREFETCH', detail: `math: 隣接 ${pf.prefetched.length} ページを先読み` });

  // 6. Planner へ Context Switch 復帰 → 仮説 B に更新 → Memory 保存
  const sw2 = contextSwitch(g, mathId, plannerId);
  g = sw2.graph;
  switches++;
  for (const ev of sw2.events) events.push({ kind: 'SWITCH', detail: ev.detail });
  const hB = updateExecution(g, plannerId, { hypothesis: 'B: 数式も確認した（x=-1）' });
  g = hB.graph;
  events.push({ kind: 'HYPOTHESIS', detail: 'planning 仮説 A → B' });
  const mem = commitMemory(g, plannerId, 'final_hypothesis', 'B: 数式も確認した（x=-1）');
  g = mem.graph;
  events.push({ kind: 'MEMORY', detail: 'planning: final_hypothesis を Memory へ保存' });

  return {
    graph: g,
    contextId,
    events,
    planner: executionOf(g, plannerId)!,
    math: executionOf(g, mathId)!,
    faults,
    switches,
    prefetched: prefetchedTotal,
    finalHypothesis: executionOf(g, plannerId)!.hypothesis,
  };
}

export interface MemoryHierarchyDemoResult {
  graph: AilsmGraph;
  contextId: number;
  chunkCount: number;
  spanCount: number;
  equationSpanCount: number;
  tlbFirst: boolean; // 初回翻訳はミス（走査してキャッシュ）
  tlbSecond: boolean; // 2回目はヒット（Fault しない）
  tlbHitRate: number;
  frameLabels: string[];
  mergedHypothesis: string;
  tiers: TierCounts;
  cursor: number;
  attention: string[];
  currentChunk: number | null;
  currentSpan: number | null;
}

/**
 * AI Memory Hierarchy デモ（Phase 0.22）:
 * Chunk/Span 階層 → Cursor/Attention（途中再開）→ Reasoning Stack（branch A/B → merge）
 * → Context TLB（2回目は Fault しない）→ Hot/Warm/Cold Tier。
 */
export function runMemoryHierarchyDemo(): MemoryHierarchyDemoResult {
  const text = [
    'これはメモリ階層の研究ノートである。まず概要を説明する。次にページングの概念を導入する。',
    '式1: x^2+2x+1=0 を考える。式2: ∫x dx=(1/2)x^2+C を確認する。式3: d/dx(x^3)=3x^2 を計算する。',
    'ここで推論Aと推論Bを同時進行させる。最後にマージする。',
    'まとめ: AI OS は必要ページだけを読む。これはメモリ階層として一貫している。',
  ].join('\n\n');

  let g = createContext({ nodes: [], edges: [] }, 'MH研究ノート', text, DEFAULT_PAGE_SIZE).graph;
  const context = contextOf(g, 1);
  if (!context) throw new Error('AVM: コンテキスト初期化に失敗');
  const contextId = context.id;

  // 1. Chunk / Span 階層（ページより細かい単位）
  const sub = subdivideContext(g, contextId);
  g = sub.graph;
  const chunkCount = sub.chunkIds.length;
  const spanCount = sub.spanIds.length;
  const equationSpanCount = g.nodes.filter((n) => n.kind === 'span' && n.attrs.kind === 'equation').length;

  // 2. Execution Context（math）
  const ex = createExecutionContext(g, contextId, 'proc1', 'math');
  g = ex.graph;
  const execId = ex.exec.id;

  // 3. Context TLB: Equation スパンの翻訳（初回 miss → 2回目 hit）
  const tlb = new ContextTlb();
  const pages = pagesOf(g, contextId);
  const eqPage = pages.find((p) =>
    g.nodes.some((n) => n.kind === 'span' && n.attrs.page === p.id && n.attrs.kind === 'equation'),
  );
  let tlbFirst = false;
  let tlbSecond = false;
  if (eqPage) {
    const t1 = translateSpan(tlb, g, contextId, eqPage.id, 'equation');
    tlbFirst = !t1.hit && t1.spanIds.length > 0;
    const t2 = translateSpan(tlb, g, contextId, eqPage.id, 'equation');
    tlbSecond = t2.hit;
  }

  // 4. Memory Tier: touch で HOT/WARM、未アクセスは COLD
  const tier = new TierManager();
  if (pages[0]) {
    tier.touch(pages[0].id);
    tier.touch(pages[0].id);
    tier.touch(pages[0].id); // 3回 → HOT
  }
  if (pages[1]) tier.touch(pages[1].id); // 1回 → WARM
  const tracked = tier.counts();
  const tiers: TierCounts = {
    hot: tracked.hot,
    warm: tracked.warm,
    cold: pages.length - (tracked.hot + tracked.warm), // 未アクセス = COLD
  };

  // 5. Reasoning Stack: branch A / branch B → merge
  const fA = pushFrame(g, execId, 'branchA', 'x=2 の可能性');
  g = fA.graph;
  const fB = pushFrame(g, execId, 'branchB', 'x=-1 の可能性');
  g = fB.graph;
  const merged = mergeFrames(g, execId, 'x=-1 が正しい');
  g = merged.graph;
  const mergedHypothesis = executionOf(g, execId)!.hypothesis;

  // 6. Cursor / Attention: 途中再開ポイント
  const resumed = updateExecution(g, execId, {
    currentChunk: 1,
    currentSpan: 2,
    cursor: 391,
    attention: ['Equation#5', 'Page#17'],
  });
  g = resumed.graph;
  const finalExec = executionOf(g, execId)!;

  return {
    graph: g,
    contextId,
    chunkCount,
    spanCount,
    equationSpanCount,
    tlbFirst,
    tlbSecond,
    tlbHitRate: tlb.hitRate(),
    frameLabels: [fA.frame.label, fB.frame.label],
    mergedHypothesis,
    tiers,
    cursor: finalExec.cursor,
    attention: finalExec.attention,
    currentChunk: finalExec.currentChunk,
    currentSpan: finalExec.currentSpan,
  };
}
