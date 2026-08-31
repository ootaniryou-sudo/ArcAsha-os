/**
 * Context SSA / Page Manager（Phase 0.20）— AI Virtual Memory（AVM）
 *
 * 「文章」ではなく「Context Object」を OS が管理する。
 * 入力（PDF / 長文 / コード）をそのまま持たず、固定サイズページへ分割して Memory 空間へ置く。
 *
 *   Input(500ページPDF) → splitContext → Context#N contains Page#1..Page#N
 *
 * Layer 1: Context Virtual Memory — 入力はそのまま持たない
 * Layer 2: Context Paging — CPU のページングと同様、必要ページだけをロード
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export const DEFAULT_PAGE_SIZE = 64; // 文字単位の固定ページサイズ
/** 既定のページ・オーバーラップ（スライド窓）。事実がページ境界で跨いでも片方のページに全体が収まるようにする */
export const DEFAULT_PAGE_OVERLAP = 32;

export interface ContextObject {
  id: number;
  title: string;
  text: string;
  pageSize: number;
  overlap: number;
  pageCount: number;
}

export interface PageObject {
  id: number;
  contextId: number;
  index: number; // 0-based
  text: string;
}

/**
 * 長文を固定サイズページへ分割（純関数 — CPU のページングに相当）。
 * overlap > 0 のときスライド窓で分割し、隣接ページが重なる。
 * これにより **overlap 文字以下の長さの事実**は必ずいずれかのページに全体として
 * 含まれる（境界に跨っても検索から漏れない）。より長い事実は境界認識型 chunking
 * が必要になる（overlap は保証範囲を表す）。
 */
export function splitContext(text: string, pageSize = DEFAULT_PAGE_SIZE, overlap = 0): string[] {
  const o = normalizeOverlap(pageSize, overlap);
  const stride = pageSize - o;
  const pages: string[] = [];
  for (let i = 0; i < text.length; i += stride) {
    pages.push(text.slice(i, i + pageSize));
  }
  if (pages.length === 0) pages.push('');
  return pages;
}

/** overlap を [0, pageSize-1] にクランプする（範囲外で文脈欠落や 1 文字 1 ページへの爆発を防ぐ） */
function normalizeOverlap(pageSize: number, overlap: number): number {
  const ps = Math.max(1, Math.floor(pageSize));
  return Math.min(Math.max(0, Math.floor(overlap)), ps - 1);
}

export interface CreateContextResult {
  graph: AilsmGraph;
  contextId: number;
  pageIds: number[];
}

/** Context#N + Page#N ノードを SSA に追加（context `contains` page） */
export function createContext(
  g: AilsmGraph,
  title: string,
  text: string,
  pageSize = DEFAULT_PAGE_SIZE,
  overlap = 0,
): CreateContextResult {
  const o = normalizeOverlap(pageSize, overlap);
  const pages = splitContext(text, pageSize, o);
  const stride = pageSize - o;
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const contextId = b.addNode('context', title, 'string', {
    title,
    text, // 実体は Kernel（Context Object）が保持
    charCount: text.length,
    pageSize,
    overlap,
    pageCount: pages.length,
  });
  const pageIds: number[] = [];
  pages.forEach((pageText, i) => {
    const pid = b.addNode('page', `${title} p${i + 1}`, 'string', {
      context: title,
      index: i,
      offset: i * stride,
      length: pageText.length,
      text: pageText,
    });
    pageIds.push(pid);
    b.connect(contextId, pid, 'contains');
  });
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), contextId, pageIds };
}

/** Context Object を取得（実体の参照） */
export function contextOf(g: AilsmGraph, contextId: number): ContextObject | undefined {
  const n = g.nodes.find((x) => x.id === contextId && x.kind === 'context');
  if (!n) return undefined;
  return {
    id: n.id,
    title: String(n.attrs.title ?? ''),
    text: String(n.attrs.text ?? ''),
    pageSize: Number(n.attrs.pageSize ?? DEFAULT_PAGE_SIZE),
    overlap: Number(n.attrs.overlap ?? 0),
    pageCount: Number(n.attrs.pageCount ?? 0),
  };
}

/** Page Manager: Context 配下のページを列挙（`contains` エッジで判定） */
export function pagesOf(g: AilsmGraph, contextId: number): PageObject[] {
  const edges = g.edges.filter((e) => e.from === contextId && e.rel === 'contains');
  const out: PageObject[] = [];
  for (const e of edges) {
    const p = g.nodes.find((n) => n.id === e.to && n.kind === 'page');
    if (p) {
      out.push({ id: p.id, contextId, index: Number(p.attrs.index ?? 0), text: String(p.attrs.text ?? '') });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Page Manager: ページをロード（参照操作 — 実体は Kernel が保持） */
export function loadPage(g: AilsmGraph, pageId: number): PageObject | undefined {
  const p = g.nodes.find((n) => n.id === pageId && n.kind === 'page');
  if (!p) return undefined;
  const edge = g.edges.find((e) => e.to === pageId && e.rel === 'contains');
  return {
    id: p.id,
    contextId: edge ? edge.from : 0,
    index: Number(p.attrs.index ?? 0),
    text: String(p.attrs.text ?? ''),
  };
}
