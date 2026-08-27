/**
 * AVM テレメトリ・ワークスペース — チャット / API サーバーから使う
 * 「AI モデルによる AVM（仮想メモリ）読み書き」を記録・可視化するための層。
 *
 * 実際の AVM（storeContext / requestSlice / cacheResult）をラップし、
 *   - 誰が（actor: user / search / math / モデルID）
 *   - 何を（context.write / slice.read / cache.write / model.call / tier.move）
 *   - 何バイト
 * をイベントとして記録する。イベントは /api/avm でスナップショット化して
 * ブラウザ（チャットUI）に表示する。
 *
 * 注意: AVM は SSA（immutable・毎回リビルドでノードIDが再採番される）のため、
 * このワークスペースは「ページ状態（resident / tier / アクセス回数）」を
 * タイトル+インデックスで安定管理する。
 */
import type { AilsmGraph } from '../ailsm/ailsm.js';
import {
  storeContext as avmStoreContext,
  requestSlice as avmRequestSlice,
  cacheResult as avmCacheResult,
} from '../ailsm/avm.js';
import { contextOf, pagesOf } from '../ailsm/context.js';
import { TierManager } from '../ailsm/tier.js';
import type { MemoryTier } from '../ailsm/tier.js';
import type { ExpertKind } from '../ailsm/slice.js';
import type { CacheKind } from '../ailsm/cache.js';

export type AvmEventKind =
  | 'context.write'
  | 'slice.read'
  | 'cache.write'
  | 'cache.hit'
  | 'model.call'
  | 'tier.move'
  | 'evict';

export interface AvmEvent {
  ts: number;
  kind: AvmEventKind;
  actor: string; // user / search / math / planning / モデルID
  contextTitle?: string;
  pageIndex?: number;
  detail: string;
  bytes?: number;
}

export interface AvmContextView {
  title: string;
  chars: number;
  pageCount: number;
  pageSize: number;
  residentPages: number;
}

export interface AvmPageView {
  contextTitle: string;
  index: number;
  chars: number;
  resident: boolean;
  tier: MemoryTier;
  accessCount: number;
  text: string;
}

export interface AvmCacheView {
  contextTitle: string;
  kind: string;
  key: string;
  chars: number;
  actor: string;
  ts: number;
}

export interface AvmSnapshot {
  contexts: AvmContextView[];
  pages: AvmPageView[];
  caches: AvmCacheView[];
  events: AvmEvent[];
  stats: {
    reads: number;
    writes: number;
    modelCalls: number;
    cacheHits: number;
    residentPages: number;
    residentBytes: number;
    tierCounts: { hot: number; warm: number; cold: number };
  };
}

const MAX_EVENTS = 500;

export class AvmWorkspace {
  private graph: AilsmGraph = { nodes: [], edges: [] };
  /** contextTitle → TierManager（ページインデックスがコンテキスト間で衝突しないよう分離） */
  private readonly tiers = new Map<string, TierManager>();
  /** contextTitle → contextId（現行グラフ内） */
  private readonly contexts = new Map<string, number>();
  /** "title:index" → ページ状態（安定管理） */
  private readonly pageState = new Map<string, { chars: number; resident: boolean; accessCount: number; tier: MemoryTier }>();
  private readonly caches: AvmCacheView[] = [];
  private readonly events: AvmEvent[] = [];
  private reads = 0;
  private writes = 0;
  private modelCalls = 0;
  private cacheHits = 0;

  /** イベント記録（リングバッファ） */
  private pushEvent(e: Omit<AvmEvent, 'ts'>): void {
    this.events.push({ ...e, ts: Date.now() });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /** 知識 / 会話を AVM に書き込む（Context Object 生成） */
  storeContext(title: string, text: string, actor = 'user'): void {
    const res = avmStoreContext(this.graph, title, text);
    this.graph = res.graph;
    this.contexts.set(title, res.context.id);
    const ctx = res.context;
    const pageCount = ctx.pageCount;
    // ページ状態を更新（chars は毎回最新化。resident / tier / accessCount は維持）
    const pagesByIdx = new Map(pagesOf(res.graph, res.context.id).map((p) => [p.index, p]));
    for (let i = 0; i < pageCount; i++) {
      const key = `${title}:${i}`;
      const chars = pagesByIdx.get(i)?.text.length ?? 0;
      const st = this.pageState.get(key);
      if (st) st.chars = chars;
      else this.pageState.set(key, { chars, resident: false, accessCount: 0, tier: 'cold' });
    }
    // ページ数が減った場合の残存キーを削除
    for (const k of [...this.pageState.keys()]) {
      if (k.startsWith(`${title}:`)) {
        const idx = Number(k.slice(title.length + 1));
        if (Number.isInteger(idx) && idx >= pageCount) this.pageState.delete(k);
      }
    }
    this.pushEvent({
      kind: 'context.write',
      actor,
      contextTitle: title,
      detail: `「${title}」を AVM に登録（${text.length} chars / ${pageCount} pages）`,
      bytes: text.length,
    });
  }

  /** Expert（AI モデル）が AVM の必要ページだけを読み込む（Slice Loader + Tier 更新） */
  readSlice(title: string, expert: ExpertKind, query: string, actor = expert): SliceLoadInfo | null {
    const contextId = this.contexts.get(title);
    if (contextId === undefined) return null;
    const res = avmRequestSlice(this.graph, contextId, expert, query);
    this.graph = res.graph;
    const load = res.load;
    const loadedText = load.loadedText;
    let bytes = 0;
    const byId = new Map(pagesOf(this.graph, contextId).map((p) => [p.id, p]));
    const tm = this.tierManager(title);
    for (const pid of load.pageIds) {
      const p = byId.get(pid);
      const index = p?.index ?? -1;
      const key = `${title}:${index}`;
      const st = this.pageState.get(key);
      if (st) {
        st.resident = true;
        st.accessCount += 1;
        const prev = st.tier;
        const next = tm.touch(index);
        st.tier = next;
        bytes += st.chars;
        if (next !== prev && (prev === 'cold' || next === 'hot')) {
          this.pushEvent({
            kind: 'tier.move',
            actor,
            contextTitle: title,
            pageIndex: index,
            detail: `page#${index} ${prev.toUpperCase()} → ${next.toUpperCase()}`,
          });
        }
      }
    }
    this.reads++;
    this.pushEvent({
      kind: 'slice.read',
      actor,
      contextTitle: title,
      detail: `${expert} expert が ${load.pageIds.length} ページ / ${loadedText.length} chars を AVM から読み込み`,
      bytes,
    });
    return { pageIds: load.pageIds, loadedText, bytes };
  }

  /** AI モデルが解析結果を AVM に書き込む（Context Cache） */
  writeCache(title: string, kind: string, key: string, value: string, actor: string): boolean {
    const contextId = this.contexts.get(title);
    if (contextId === undefined) return false;
    const res = avmCacheResult(this.graph, contextId, kind as CacheKind, key, value);
    this.graph = res.graph;
    if (res.hit) {
      this.cacheHits++;
      this.pushEvent({
        kind: 'cache.hit',
        actor,
        contextTitle: title,
        detail: `キャッシュヒット（${kind}:${key}）— 再解析不要`,
        bytes: 0,
      });
      return false;
    }
    this.writes++;
    this.caches.unshift({ contextTitle: title, kind, key, chars: value.length, actor, ts: Date.now() });
    this.pushEvent({
      kind: 'cache.write',
      actor,
      contextTitle: title,
      detail: `${actor} が解析結果を AVM に書き込み（${kind}:${key} / ${value.length} chars）`,
      bytes: value.length,
    });
    return true;
  }

  /** 実モデル呼び出しを記録 */
  recordModelCall(model: string, ms: number, detail: string): void {
    this.modelCalls++;
    this.pushEvent({ kind: 'model.call', actor: model, detail: `${detail}（${ms}ms）`, bytes: 0 });
  }

  /** ページを evict（resident から除外・デモ用に任意呼び出し可） */
  evictPage(title: string, index: number, actor = 'os'): void {
    const key = `${title}:${index}`;
    const st = this.pageState.get(key);
    if (!st || !st.resident) return;
    st.resident = false;
    st.tier = 'cold';
    this.pushEvent({
      kind: 'evict',
      actor,
      contextTitle: title,
      pageIndex: index,
      detail: `page#${index} を resident set から evict`,
    });
  }

  /** 登録済みコンテキストのタイトル一覧 */
  contextTitles(): string[] {
    return [...this.contexts.keys()];
  }

  /**
   * 知識コンテキストをキーワード重複スコアリングで検索し、関連ページを
   * AVM（resident + tier）へロードする。selectPages の完全一致に依存せず
   * 日本語/英数のトークン重複で「関連ページだけ」を読む search expert 実装。
   */
  searchKnowledge(
    query: string,
    limitPerContext = 2,
    actor = 'search',
  ): { title: string; loadedText: string; bytes: number }[] {
    const tokens = this.tokenize(query);
    const out: { title: string; loadedText: string; bytes: number }[] = [];
    for (const [title, contextId] of this.contexts) {
      if (title === '会話') continue;
      const all = pagesOf(this.graph, contextId);
      const scored = all
        .map((p) => ({ p, score: tokens.filter((t) => p.text.toLowerCase().includes(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limitPerContext);
      if (scored.length === 0) continue;
      let loadedText = '';
      let bytes = 0;
      const tm = this.tierManager(title);
      for (const { p } of scored) {
        const key = `${title}:${p.index}`;
        const st = this.pageState.get(key);
        if (st) {
          st.resident = true;
          st.accessCount += 1;
          const prev = st.tier;
          const next = tm.touch(p.index);
          st.tier = next;
          if (next !== prev) {
            this.pushEvent({
              kind: 'tier.move',
              actor,
              contextTitle: title,
              pageIndex: p.index,
              detail: `page#${p.index} ${prev.toUpperCase()} → ${next.toUpperCase()}`,
            });
          }
          bytes += st.chars;
        }
        loadedText += (loadedText ? '\n' : '') + p.text;
      }
      this.reads++;
      this.pushEvent({
        kind: 'slice.read',
        actor,
        contextTitle: title,
        detail: `search expert が ${scored.length} ページ / ${loadedText.length} chars を知識から読み込み`,
        bytes,
      });
      out.push({ title, loadedText, bytes });
    }
    return out;
  }

  private tokenize(s: string): string[] {
    const t = s.toLowerCase();
    const tokens = t.match(/[a-z0-9]+|[\u3040-\u30ff\u4e00-\u9fff]{2,}/g) ?? [];
    return [...new Set(tokens)].filter((x) => x.length >= 2);
  }

  /** コンテキストごとの TierManager（ページインデックスが衝突しないよう分離） */
  private tierManager(title: string): TierManager {
    let tm = this.tiers.get(title);
    if (!tm) {
      tm = new TierManager();
      this.tiers.set(title, tm);
    }
    return tm;
  }

  /** 現在の AVM 状態をスナップショット化（ブラウザ描画用） */
  snapshot(eventsLimit = 120): AvmSnapshot {
    const contexts: AvmContextView[] = [];
    const pages: AvmPageView[] = [];
    for (const [title, contextId] of this.contexts) {
      const ctx = contextOf(this.graph, contextId);
      const all = pagesOf(this.graph, contextId);
      let residentPages = 0;
      for (const p of all) {
        const st = this.pageState.get(`${title}:${p.index}`);
        const tier = st?.tier ?? 'cold';
        const resident = st?.resident ?? false;
        if (resident) residentPages++;
        pages.push({
          contextTitle: title,
          index: p.index,
          chars: p.text.length,
          resident,
          tier,
          accessCount: st?.accessCount ?? 0,
          text: p.text,
        });
      }
      contexts.push({
        title,
        chars: ctx?.text.length ?? 0,
        pageCount: all.length,
        pageSize: ctx?.pageSize ?? 0,
        residentPages,
      });
    }
    const residentBytes = [...this.pageState.values()].filter((s) => s.resident).reduce((s, x) => s + x.chars, 0);
    return {
      contexts,
      pages: pages.sort((a, b) => (a.contextTitle < b.contextTitle ? -1 : a.contextTitle > b.contextTitle ? 1 : a.index - b.index)),
      caches: this.caches.slice(0, 50),
      events: [...this.events].reverse().slice(0, eventsLimit),
      stats: {
        reads: this.reads,
        writes: this.writes,
        modelCalls: this.modelCalls,
        cacheHits: this.cacheHits,
        residentPages: this.residentCount(),
        residentBytes,
        tierCounts: this.tierCounts(),
      },
    };
  }

  private residentCount(): number {
    let n = 0;
    for (const s of this.pageState.values()) if (s.resident) n++;
    return n;
  }

  private tierCounts(): { hot: number; warm: number; cold: number } {
    const out = { hot: 0, warm: 0, cold: 0 };
    for (const tm of this.tiers.values()) {
      const c = tm.counts();
      out.hot += c.hot;
      out.warm += c.warm;
      out.cold += c.cold;
    }
    return out;
  }
}

export interface SliceLoadInfo {
  pageIds: number[];
  loadedText: string;
  bytes: number;
}
