/**
 * Web 検索 — DuckDuckGo のリアルタイム検索（無料・API キー不要）
 *
 * 目的: チャット / Agent が最新情報を取得できるように、DuckDuckGo の HTML 検索
 * （html.duckduckgo.com）を fetch して結果を抽出する。API キー不要でリアルタイム検索できる。
 *
 * 注意: DuckDuckGo の HTML エンドポイントは公式の安定 API ではないため、DOM 構造が
 * 変わると解析が崩れる可能性がある。その場合は Instant Answer API（api.duckduckgo.com）
 * にフォールバックする。失敗時は空配列を返す（チャットを止めない）。
 */
import { performance } from 'node:perf_hooks';

/** 検索結果 1 件。 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 検索オプション。 */
export interface WebSearchOptions {
  /** 取得する最大件数（既定 5）。 */
  maxResults?: number;
  /** タイムアウト（ms・既定 10_000）。 */
  timeoutMs?: number;
}

/** 検索実行結果。 */
export interface WebSearchOutcome {
  ok: boolean;
  results: WebSearchResult[];
  error?: string;
  ms: number;
  source: 'duckduckgo-html' | 'duckduckgo-ia' | 'none';
}

/** HTML からテキストを抽出（タグ除去・エンティティ簡易デコード）。 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** エンティティをデコードして URL を返す。 */
export function decodeUrl(s: string): string {
  try {
    const m = /uddg=([^&]+)/.exec(s);
    if (m) return decodeURIComponent(m[1]);
  } catch {
    /* ignore */
  }
  return s;
}

/**
 * DuckDuckGo HTML 検索を実行して結果を返す。
 * 失敗時は Instant Answer API にフォールバック、それも失敗なら空配列。
 */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<WebSearchOutcome> {
  const t0 = performance.now();
  const maxResults = opts.maxResults ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const q = query.trim();
  if (!q) return { ok: false, results: [], error: '検索クエリが空です', ms: 0, source: 'none' };

  // 1) HTML 検索（html.duckduckgo.com）— 結果タイトル・URL・スニペットを抽出
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const html = await res.text();
      const results = parseDuckHtml(html, maxResults);
      if (results.length > 0) {
        return { ok: true, results, ms: Math.round(performance.now() - t0), source: 'duckduckgo-html' };
      }
    }
  } catch (e) {
    // HTML 検索失敗 → IA API へフォールバック
    const err = (e as Error).message;
    const ia = await duckIaSearch(q, maxResults, timeoutMs, t0);
    return ia.ok ? ia : { ok: false, results: [], error: err, ms: Math.round(performance.now() - t0), source: 'none' };
  }

  // 2) HTML 検索で結果なし → Instant Answer API へフォールバック
  const ia = await duckIaSearch(q, maxResults, timeoutMs, t0);
  return ia.ok ? ia : { ok: false, results: [], error: '検索結果がありません', ms: Math.round(performance.now() - t0), source: 'none' };
}

/** DuckDuckGo HTML 検索結果ページをパースして結果一覧を返す。 */
export function parseDuckHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // 各結果は <a rel="nofollow" class="result__a" href="...">title</a> で始まる。
  // このアンカーを順に検索し、そのブロック内のスニペットを取得する。
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  const anchors: Array<{ start: number; end: number; url: string; title: string }> = [];
  while ((m = anchorRe.exec(html)) !== null) {
    anchors.push({ start: m.index, end: m.index + m[0].length, url: decodeUrl(m[1]), title: stripHtml(m[2]).slice(0, 200) });
  }
  for (let i = 0; i < anchors.length && results.length < maxResults; i++) {
    const a = anchors[i];
    // スニペット: このアンカーの後ろから次のアンカーまでを探し、result__snippet を取得
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1].start : html.length;
    const block = html.slice(a.end, blockEnd);
    const snipMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippet = snipMatch ? stripHtml(snipMatch[1]).slice(0, 400) : '';
    results.push({ title: a.title, url: a.url, snippet });
  }
  return results;
}

/** DuckDuckGo Instant Answer API（api.duckduckgo.com）。情報量は少ないがフォールバックに使う。 */
async function duckIaSearch(q: string, maxResults: number, timeoutMs: number, t0: number): Promise<WebSearchOutcome> {
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { 'User-Agent': 'ArcAshaBot/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, results: [], error: `IA API ${res.status}`, ms: Math.round(performance.now() - t0), source: 'none' };
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
    };
    const results: WebSearchResult[] = [];
    if (data.AbstractText) {
      results.push({ title: data.Heading || q, url: data.AbstractURL || '', snippet: String(data.AbstractText).slice(0, 400) });
    }
    const topics = (data.RelatedTopics || []).slice(0, maxResults);
    for (const t of topics) {
      if (results.length >= maxResults) break;
      if (t.Topics) {
        for (const st of t.Topics) {
          if (results.length >= maxResults) break;
          if (st.Text) results.push({ title: stripHtml(st.Text).split(' - ')[0], url: st.FirstURL || '', snippet: stripHtml(st.Text).slice(0, 400) });
        }
      } else if (t.Text) {
        results.push({ title: stripHtml(t.Text).split(' - ')[0], url: t.FirstURL || '', snippet: stripHtml(t.Text).slice(0, 400) });
      }
    }
    return results.length > 0
      ? { ok: true, results, ms: Math.round(performance.now() - t0), source: 'duckduckgo-ia' }
      : { ok: false, results: [], error: 'IA API に結果なし', ms: Math.round(performance.now() - t0), source: 'none' };
  } catch (e) {
    return { ok: false, results: [], error: (e as Error).message, ms: Math.round(performance.now() - t0), source: 'none' };
  }
}
