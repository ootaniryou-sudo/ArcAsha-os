/**
 * Web 検索 — 複数プロバイダのフォールバックチェーン（API キー不要の DuckDuckGo 含む）
 *
 * 目的: チャット / Agent が最新情報を取得できるように、複数の検索 API を順に試す。
 * 各プロバイダは無料枠を持つ（Tavily / Serper / Brave / Exa / Google CSE）。
 * キーが設定されているプロバイダを試し、レート制限(429)・無料枠枯渇(402)・エラーが
 * 返ったら次のプロバイダへフォールバックする。DuckDuckGo（キー不要）は最後の保険。
 *
 * プロバイダ優先順: 登録順（env にキーがあるもの）。各プロバイダの「直近の失敗」を
 * 記録し、セッション中に失敗したプロバイダは次回からスキップする（無料枠の無駄遣い防止）。
 *
 * API キーは .env / 環境変数で管理（.env は .gitignore 済み・PUSH されない）:
 *   TAVILY_API_KEY, SERPER_API_KEY, BRAVE_API_KEY, EXA_API_KEY,
 *   GOOGLE_CSE_KEY + GOOGLE_CSE_ID
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
  source: string;
}

/** 検索プロバイダ ID。 */
export type SearchProviderId = 'tavily' | 'serper' | 'brave' | 'exa' | 'google-cse' | 'duckduckgo';

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
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

/** エンティティをデコードして URL を返す（DuckDuckGo の uddg パラメータ）。 */
export function decodeUrl(s: string): string {
  try {
    const m = /uddg=([^&]+)/.exec(s);
    if (m) return decodeURIComponent(m[1]);
  } catch {
    /* ignore */
  }
  return s;
}

/** 広告 / トラッキングのリダイレクト URL か（検索結果に含めない）。 */
function isAdUrl(url: string): boolean {
  if (!url) return true;
  return /(bing\.com\/aclick|duckduckgo\.com\/y\.js|ad_domain=|ad_provider=|utm_(campaign|content|term)=)/i.test(url);
}

/** 各プロバイダの直近の失敗状態（セッション中に無料枠枯渇・レート制限したものをスキップ）。 */
const providerCooldown = new Map<SearchProviderId, number>(); // provider -> until(ms)
const COOLDOWN_MS = 60_000; // 失敗後 60 秒スキップ

/** プロバイダが現在クールダウン中（スキップすべき）か。 */
function inCooldown(id: SearchProviderId): boolean {
  const until = providerCooldown.get(id);
  return until !== undefined && Date.now() < until;
}

/** プロバイダをクールダウンに入れる（無料枠枯渇・レート制限時）。 */
function markCooldown(id: SearchProviderId): void {
  providerCooldown.set(id, Date.now() + COOLDOWN_MS);
}

/** 指定プロバイダの API キーが設定されているか。 */
function hasKey(id: SearchProviderId): boolean {
  switch (id) {
    case 'tavily': return !!process.env.TAVILY_API_KEY;
    case 'serper': return !!process.env.SERPER_API_KEY;
    case 'brave': return !!process.env.BRAVE_API_KEY;
    case 'exa': return !!process.env.EXA_API_KEY;
    case 'google-cse': return !!process.env.GOOGLE_CSE_KEY && !!process.env.GOOGLE_CSE_ID;
    default: return false;
  }
}

/* ── 各プロバイダの実装 ─────────────────────────────────────────── */

async function tavilySearch(q: string, maxResults: number, timeoutMs: number): Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { results: [], error: 'TAVILY_API_KEY 未設定' };
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: q, max_results: maxResults, search_depth: 'basic' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429 || res.status === 402) return { results: [], error: `Tavily ${res.status}`, exhausted: true };
  if (!res.ok) return { results: [], error: `Tavily ${res.status}` };
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return {
    results: (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.content || '').slice(0, 400),
    })),
  };
}

async function serperSearch(q: string, maxResults: number, timeoutMs: number): Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { results: [], error: 'SERPER_API_KEY 未設定' };
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q, num: maxResults }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429 || res.status === 402) return { results: [], error: `Serper ${res.status}`, exhausted: true };
  if (!res.ok) return { results: [], error: `Serper ${res.status}` };
  const data = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return {
    results: (data.organic || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.link || '',
      snippet: (r.snippet || '').slice(0, 400),
    })),
  };
}

async function braveSearch(q: string, maxResults: number, timeoutMs: number): Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return { results: [], error: 'BRAVE_API_KEY 未設定' };
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${maxResults}`, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429 || res.status === 402) return { results: [], error: `Brave ${res.status}`, exhausted: true };
  if (!res.ok) return { results: [], error: `Brave ${res.status}` };
  const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return {
    results: ((data.web?.results) || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.description || '').slice(0, 400),
    })),
  };
}

async function exaSearch(q: string, maxResults: number, timeoutMs: number): Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> {
  const key = process.env.EXA_API_KEY;
  if (!key) return { results: [], error: 'EXA_API_KEY 未設定' };
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query: q, numResults: maxResults, contents: { text: true } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429 || res.status === 402) return { results: [], error: `Exa ${res.status}`, exhausted: true };
  if (!res.ok) return { results: [], error: `Exa ${res.status}` };
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
  return {
    results: (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.text || '').slice(0, 400),
    })),
  };
}

async function googleCseSearch(q: string, maxResults: number, timeoutMs: number): Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return { results: [], error: 'GOOGLE_CSE_KEY / GOOGLE_CSE_ID 未設定' };
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=${Math.min(maxResults, 10)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429 || res.status === 402) return { results: [], error: `Google CSE ${res.status}`, exhausted: true };
  if (!res.ok) return { results: [], error: `Google CSE ${res.status}` };
  const data = (await res.json()) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
  return {
    results: (data.items || []).slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.link || '',
      snippet: (r.snippet || '').slice(0, 400),
    })),
  };
}

/** DuckDuckGo HTML 検索（キー不要・最後の保険）。 */
async function duckHtmlSearch(q: string, maxResults: number, timeoutMs: number): Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 202 || res.status === 429) return { results: [], error: `DuckDuckGo ${res.status}`, exhausted: true };
    if (!res.ok) return { results: [], error: `DuckDuckGo ${res.status}` };
    const html = await res.text();
    return { results: parseDuckHtml(html, maxResults) };
  } catch (e) {
    return { results: [], error: (e as Error).message };
  }
}

/** DuckDuckGo Instant Answer API（情報量は少ないがキー不要）。 */
async function duckIaSearch(q: string, maxResults: number, timeoutMs: number): Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> {
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { results: [], error: `IA API ${res.status}` };
    const data = (await res.json()) as {
      AbstractText?: string; AbstractURL?: string; Heading?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
    };
    const results: WebSearchResult[] = [];
    if (data.AbstractText) results.push({ title: data.Heading || q, url: data.AbstractURL || '', snippet: String(data.AbstractText).slice(0, 400) });
    for (const t of (data.RelatedTopics || []).slice(0, maxResults)) {
      if (results.length >= maxResults) break;
      if (t.Topics) for (const st of t.Topics) {
        if (results.length >= maxResults) break;
        if (st.Text) results.push({ title: stripHtml(st.Text).split(' - ')[0], url: st.FirstURL || '', snippet: stripHtml(st.Text).slice(0, 400) });
      } else if (t.Text) {
        results.push({ title: stripHtml(t.Text).split(' - ')[0], url: t.FirstURL || '', snippet: stripHtml(t.Text).slice(0, 400) });
      }
    }
    return { results };
  } catch (e) {
    return { results: [], error: (e as Error).message };
  }
}

/**
 * 複数プロバイダのフォールバックチェーンで Web 検索を実行する。
 * キー設定済みの API プロバイダを順に試し、成功したらその結果を返す。
 * 無料枠枯渇(402)・レート制限(429)したプロバイダはクールダウン（以後スキップ）。
 * どれも失敗したら DuckDuckGo（キー不要）へフォールバック。
 */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<WebSearchOutcome> {
  const t0 = performance.now();
  const maxResults = opts.maxResults ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const q = query.trim();
  if (!q) return { ok: false, results: [], error: '検索クエリが空です', ms: 0, source: 'none' };

  // キー設定済みの API プロバイダ（クールダウン中のものはスキップ）
  const apiProviders: Array<{ id: SearchProviderId; run: () => Promise<{ results: WebSearchResult[]; error?: string; exhausted?: boolean }> }> = [
    { id: 'tavily', run: () => tavilySearch(q, maxResults, timeoutMs) },
    { id: 'serper', run: () => serperSearch(q, maxResults, timeoutMs) },
    { id: 'brave', run: () => braveSearch(q, maxResults, timeoutMs) },
    { id: 'exa', run: () => exaSearch(q, maxResults, timeoutMs) },
    { id: 'google-cse', run: () => googleCseSearch(q, maxResults, timeoutMs) },
  ];

  const errors: string[] = [];
  for (const p of apiProviders) {
    if (!hasKey(p.id) || inCooldown(p.id)) continue;
    try {
      const out = await p.run();
      if (out.results.length > 0) {
        return { ok: true, results: out.results, ms: Math.round(performance.now() - t0), source: p.id };
      }
      if (out.exhausted) {
        markCooldown(p.id);
        errors.push(`${p.id}: 無料枠枯渇/レート制限`);
      } else if (out.error) {
        errors.push(`${p.id}: ${out.error}`);
      }
    } catch (e) {
      errors.push(`${p.id}: ${(e as Error).message}`);
    }
  }

  // DuckDuckGo（キー不要）へフォールバック
  const dd = await duckHtmlSearch(q, maxResults, timeoutMs);
  if (dd.results.length > 0) {
    return { ok: true, results: dd.results, ms: Math.round(performance.now() - t0), source: 'duckduckgo' };
  }
  const ia = await duckIaSearch(q, maxResults, timeoutMs);
  if (ia.results.length > 0) {
    return { ok: true, results: ia.results, ms: Math.round(performance.now() - t0), source: 'duckduckgo-ia' };
  }
  return {
    ok: false,
    results: [],
    error: errors.length > 0 ? errors.join('; ') : '検索結果がありません',
    ms: Math.round(performance.now() - t0),
    source: 'none',
  };
}

/** DuckDuckGo HTML 検索結果ページをパースして結果一覧を返す。 */
export function parseDuckHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  const anchors: Array<{ start: number; end: number; url: string; title: string }> = [];
  while ((m = anchorRe.exec(html)) !== null) {
    anchors.push({ start: m.index, end: m.index + m[0].length, url: decodeUrl(m[1]), title: stripHtml(m[2]).slice(0, 200) });
  }
  for (let i = 0; i < anchors.length && results.length < maxResults; i++) {
    const a = anchors[i];
    if (isAdUrl(a.url)) continue; // 広告 / トラッキングリンクは除外
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1].start : html.length;
    const block = html.slice(a.end, blockEnd);
    const snipMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    results.push({ title: a.title, url: a.url, snippet: snipMatch ? stripHtml(snipMatch[1]).slice(0, 400) : '' });
  }
  return results;
}
