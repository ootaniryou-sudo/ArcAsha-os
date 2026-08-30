#!/usr/bin/env npx tsx
/**
 * ArcAsha Chat Server — チャット WebUI + AVM 可視化 + OpenAI 互換 API
 *
 *  1) チャット形式で ArcAsha に質問 / 操作（/ で WebUI）
 *  2) AVM（仮想メモリ）への AI モデルによる読み書きをリアルタイム可視化
 *  3) OpenAI 互換 /v1/chat/completions — Cursor 等の外部ツールから API として接続可能
 *
 * 使い方:
 *   npx tsx src/arcasha/chat/chat-server.ts            # http://localhost:4780
 *   npx tsx src/arcasha/chat/chat-server.ts --port 9000
 *   env ARCASHA_CHAT_PORT=9000 npx tsx src/arcasha/chat/chat-server.ts
 *
 * 環境変数 / .env:
 *   DEEPSEEK_API_KEY / DEEPSEEK_API_BASE / DEEPSEEK_MODEL を設定すると
 *   DeepSeek を実モデルノードとして自動接続する（無ければモックで動作）。
 *
 * Cursor 等からの接続例（OpenAI 互換）:
 *   baseURL = http://localhost:4780/v1
 *   POST /v1/chat/completions  { model, messages:[{role,content}], max_tokens }
 */
import 'dotenv/config';
import http from 'node:http';
import { ExpertHub } from '../experts/registry.js';
import { AvmWorkspace } from './avm-telemetry.js';

// ─── 設定 ─────────────────────────────────────────────────────────────
let PORT = Number(process.env.ARCASHA_CHAT_PORT ?? 4780);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') {
    const v = Number(args[++i]);
    if (Number.isInteger(v) && v > 0) PORT = v;
  }
}
const DEFAULT_MAX_TOKENS = 1024; // 推論モデル（reasoning_content + content）が回答まで収まるよう大きめに

// ─── ノード（ExpertHub）───────────────────────────────────────────────
const hub = new ExpertHub();
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
const base = (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const key = process.env.DEEPSEEK_API_KEY ?? '';

// ─── 複数モデルのエキスパート艦隊（タスクに応じて連携）──────────────
// flash = 汎用/高速、pro = 推論/数学/コード。タスク分類で適切なモデルへルーティングする。
interface FleetExpert {
  nodeId: string;
  model: string;
  role: 'general' | 'reasoning';
  label: string;
}
const fleet: FleetExpert[] = [];
if (key) {
  fleet.push({ nodeId: 'expert-flash', model, role: 'general', label: 'Flash（汎用）' });
  fleet.push({ nodeId: 'expert-pro', model: process.env.DEEPSEEK_PRO_MODEL ?? 'deepseek-v4-pro', role: 'reasoning', label: 'Pro（推論）' });
  for (const e of fleet) {
    hub.addApiNode(e.nodeId, base, key, e.model);
    console.log(`  ☁️ 実モデル接続: ${e.nodeId} (${e.model} @ ${base}) [${e.role}]`);
  }
} else {
  console.log('  ⚠️ DEEPSEEK_API_KEY が無いためモックノードで動作します（実タスクには .env を設定）');
  hub.addMockNode('mock-a', 'HuggingFaceTB/SmolLM2-135M-Instruct');
  hub.addMockNode('mock-b', 'HuggingFaceTB/SmolLM2-135M-Instruct');
  // モックも艦隊に登録（routeExpert / answerConversation が fleet 空でクラッシュしないように）
  fleet.push({ nodeId: 'mock-a', model: 'mock', role: 'general', label: 'Mock（汎用）' });
  fleet.push({ nodeId: 'mock-b', model: 'mock', role: 'reasoning', label: 'Mock（推論）' });
}

/** タスクの種類（どのモデル・エキスパートに任せるか） */
type TaskKind = 'math' | 'code' | 'reasoning' | 'search' | 'general';

/** 発言からタスク種別を推定する（簡易キーワード分類） */
function classifyTask(text: string): TaskKind {
  if (/[=∫∑√π∞]|\d+\s*[+\-*/^]\s*\d+|数学|算数|積分|微分|方程式|計算|因数分解|確率|幾何|行列|対数|三角関数|数式|数列|図形/i.test(text)) return 'math';
  if (/コード|プログラム|実装|バグ|関数|クラス|型|アルゴリズム|リファクタ|typescript|python|javascript|rust|react|api/i.test(text)) return 'code';
  if (/なぜ|理由|説明|考察|証明|戦略|計画|設計|比較|分析|仮説|どう思う/i.test(text)) return 'reasoning';
  if (/検索|調べて|とは|意味|定義|まとめ|要約|一覧/i.test(text)) return 'search';
  return 'general';
}

/** タスク種別 → 担当エキスパート（math/code/reasoning は Pro、search/general は Flash） */
function routeExpert(kind: TaskKind): FleetExpert {
  if (kind === 'math' || kind === 'code' || kind === 'reasoning') {
    return fleet.find((e) => e.role === 'reasoning') ?? fleet[0];
  }
  return fleet.find((e) => e.role === 'general') ?? fleet[0];
}

function pickNode(): string {
  if (fleet.length > 0 && hub.experts.some((e) => e.nodeId === fleet[0].nodeId)) return fleet[0].nodeId;
  return hub.experts[0]?.nodeId ?? '';
}

// ─── AVM ワークスペース + 会話履歴 ────────────────────────────────────
const ws = new AvmWorkspace();
const history: { role: 'user' | 'assistant'; content: string }[] = [];
let msgSeq = 0;
const MAX_HISTORY = 40; // 会話履歴の上限（無制限な蓄積を防ぐ）

/** 会話配列を AVM のコンテキスト用テキストへ変換する */
function messagesToText(messages: { role: string; content: string }[]): string {
  return messages.map((m, i) => `${m.role === 'user' ? 'Q' : 'A'}[${i}]: ${m.content}`).join('\n');
}

/** WebUI の会話状態を直列化する（同時リクエストで履歴が混ざらないように） */
let historyLock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = historyLock.then(fn, fn);
  historyLock = run.then(() => undefined, () => undefined);
  return run;
}

/** 軽量文字列ハッシュ（API 会話のタイトル分離用） */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * 会話配列を丸ごと AVM の指定タイトルへ書き込み、チャット 1 ターンを実行する。
 *   context.write → slice.read（search + 知識）→ model.call → cache.write
 * title を分離することで、WebUI（会話）と API（api:<hash>）の履歴が混ざらない。
 */
async function answerConversation(
  title: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens: number,
): Promise<{ reply: string; ms: number; model: string; nodeId: string; kind: TaskKind; expert: string; trace: string[] }> {
  const trace: string[] = [];
  const t0 = Date.now();
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const query = lastUser?.content ?? '';

  // タスク分類 → 担当モデルをルーティング（複数モデル連携の入口）
  const kind = classifyTask(query);
  const expert = routeExpert(kind);
  trace.push(`classify → ${kind}（担当: ${expert.label} / ${expert.model}）`);

  // 1) 会話全体を AVM へ書く
  ws.storeContext(title, messagesToText(messages), 'user');
  trace.push(`context.write ${title}`);

  // 2) search expert が AVM から必要ページを読む（会話 + 知識コンテキスト）
  const load = ws.readSlice(title, 'search', query, 'search');
  const kloads = ws.searchKnowledge(query, 2, 'search');
  const contextSnippet =
    [
      load && load.loadedText ? `[会話] ${load.loadedText.slice(0, 800)}` : '',
      ...kloads.map((k) => `[知識:${k.title}] ${k.loadedText.slice(0, 800)}`),
    ].filter(Boolean).join('\n') || '(履歴なし)';
  trace.push(`slice.read search (${load?.pageIds.length ?? 0} pages / 知識 ${kloads.length} contexts)`);

  // 3) 担当モデル（flash / pro）を呼び出し
  const prompt = [
    'あなたは ArcAsha（AI オペレーティングシステム）の上で動くエキスパートです。',
    '以下は AVM（AI 仮想メモリ）から読み込んだコンテキストです:',
    '─── context ───',
    contextSnippet,
    '──────────────',
    `質問: ${lastUser?.content ?? ''}`,
    '簡潔に日本語で答えてください。',
  ].join('\n');
  const genT0 = Date.now();
  let reply = '';
  let usedModel = expert.model;
  let usedNodeId = expert.nodeId;
  let usedExpert = expert.label;
  try {
    reply = String((await hub.generate(expert.nodeId, prompt, maxTokens)) ?? '').trim();
  } catch (e) {
    reply = `⚠️ モデル呼び出し失敗: ${String(e).slice(0, 200)}`;
  }
  // 推論モデルが思考に予算を使い切って空応答になった場合は、汎用モデルでリトライ
  if (reply === '') {
    const fallback = fleet.find((e) => e.role === 'general') ?? expert;
    trace.push(`空応答 → フォールバック: ${fallback.label}`);
    try {
      reply = String((await hub.generate(fallback.nodeId, prompt, maxTokens)) ?? '').trim();
      usedModel = fallback.model;
      usedNodeId = fallback.nodeId;
      usedExpert = fallback.label;
    } catch (e2) {
      reply = `⚠️ モデル呼び出し失敗: ${String(e2).slice(0, 200)}`;
    }
  }
  if (reply === '') reply = '（応答が空でした。もう一度お試しください）';
  const genMs = Date.now() - genT0;
  ws.recordModelCall(usedModel, genMs, `${usedNodeId} へ ${maxTokens} tokens 上限で生成`);
  trace.push(`model.call ${usedModel} (${genMs}ms)`);

  // 4) 回答を AVM に書き戻す（AI モデルの書き込み）
  msgSeq++;
  ws.writeCache(title, 'summary', `answer:${msgSeq}`, reply, usedModel);
  trace.push('cache.write 回答');

  return { reply, ms: Date.now() - t0, model: usedModel, nodeId: usedNodeId, kind, expert: usedExpert, trace };
}

// ─── チャット WebUI（HTML）───────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ArcAsha Chat — AVM 可視化付き</title>
<style>
  :root { --bg:#0b0f14; --card:#131a22; --ink:#e6f1ea; --mute:#5e7488;
          --go:#2fce7a; --warm:#e0b84a; --bad:#e05a4f; --cold:#31424f; --line:#1e2833; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:13px; height:100vh; overflow:hidden; }
  .layout { display:grid; grid-template-columns: 1fr 400px; height:100vh; }
  .chat-col { display:flex; flex-direction:column; border-right:1px solid var(--line); min-width:0; }
  .chat-col header { padding:14px 18px; border-bottom:1px solid var(--line); }
  h1 { font-size:18px; font-weight:800; letter-spacing:.04em; }
  h1 span { color:var(--go); }
  .sub { color:var(--mute); font-size:11px; margin-top:3px; }
  #msgs { flex:1; overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:12px; }
  .bubble { max-width:78%; padding:10px 14px; border-radius:12px; line-height:1.65; white-space:pre-wrap; }
  .bubble.user { align-self:flex-end; background:var(--go); color:#00130a; font-weight:600; }
  .bubble.ai { align-self:flex-start; background:var(--card); border:1px solid var(--line); }
  .bubble.ai .meta { font-size:10px; color:var(--mute); margin-top:6px; }
  .input-row { display:flex; gap:8px; padding:14px 18px; border-top:1px solid var(--line); }
  textarea { flex:1; background:#0e141b; border:1px solid var(--line); border-radius:10px; color:var(--ink); font:inherit; padding:10px 12px; resize:none; outline:none; min-height:44px; max-height:140px; }
  textarea:focus { border-color:var(--go); }
  button { background:var(--go); color:#00130a; border:none; border-radius:10px; font:inherit; font-weight:700; padding:0 20px; cursor:pointer; }
  button:disabled { opacity:.5; }
  .avm-col { overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px; }
  .avm-col header { font-size:12px; color:var(--mute); text-transform:uppercase; letter-spacing:.08em; }
  .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px; }
  .stat .v { font-size:16px; font-weight:800; }
  .stat .l { font-size:10px; color:var(--mute); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
  .card h3 { font-size:11px; color:var(--mute); text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px; }
  .ctx { margin-bottom:10px; }
  .ctx .name { font-weight:700; font-size:12px; }
  .ctx .meta { color:var(--mute); font-size:10px; }
  .pages { display:flex; gap:2px; margin-top:6px; flex-wrap:wrap; }
  .page { width:16px; height:16px; border-radius:3px; display:flex; align-items:center; justify-content:center; font-size:8px; color:#000; position:relative; }
  .page.hot { background:var(--go); }
  .page.warm { background:var(--warm); }
  .page.cold { background:var(--cold); }
  .page.resident::after { content:''; position:absolute; top:-2px; right:-2px; width:6px; height:6px; border-radius:50%; background:#fff; }
  .legend { display:flex; gap:12px; margin-top:6px; font-size:10px; color:var(--mute); }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:4px; vertical-align:-1px; }
  .caches { font-size:11px; }
  .cache { padding:5px 0; border-bottom:1px solid #17202b; display:flex; justify-content:space-between; gap:8px; }
  .cache:last-child { border-bottom:none; }
  .cache .k { color:var(--go); }
  .cache .v { color:var(--mute); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .log { font-size:10px; max-height:300px; overflow-y:auto; }
  .log .ev { padding:3px 0; border-bottom:1px solid #121a24; display:flex; gap:6px; }
  .log .ev .t { color:var(--mute); }
  .log .ev .a { color:var(--warm); }
  .log .ev .d { color:#a9c1d0; }
  .log .ev.k-context\\.write .a { color:var(--go); }
  .log .ev.k-cache\\.write .a { color:var(--go); }
  .log .ev.k-model\\.call .a { color:#7aa7ff; }
</style>
</head>
<body>
<div class="layout">
  <div class="chat-col">
    <header>
      <h1>Aka<span>sha</span> Chat</h1>
      <div class="sub">AVM 仮想メモリ経由で DeepSeek と対話 — 右パネルでモデルのメモリ読み書きを可視化 · <a href="/api/avm" style="color:var(--go)">/api/avm</a></div>
    </header>
    <div id="msgs"></div>
    <div class="input-row">
      <textarea id="inp" placeholder="ArcAsha に質問 / 操作 …（Enter 送信 / Shift+Enter 改行）"></textarea>
      <button id="send">送信</button>
    </div>
  </div>
  <div class="avm-col">
    <header>AI Virtual Memory — モデルによる読み書き</header>
    <div class="stats">
      <div class="stat"><div class="v" id="s-read">0</div><div class="l">reads（モデル読込）</div></div>
      <div class="stat"><div class="v" id="s-write">0</div><div class="l">writes（モデル書込）</div></div>
      <div class="stat"><div class="v" id="s-call">0</div><div class="l">model calls</div></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v" id="s-resident">0</div><div class="l">resident pages</div></div>
      <div class="stat"><div class="v" id="s-bytes">0 B</div><div class="l">resident bytes</div></div>
      <div class="stat"><div class="v" id="s-cache">0</div><div class="l">cache writes</div></div>
    </div>
    <div class="card">
      <h3>メモリマップ（HOT / WARM / COLD）</h3>
      <div id="ctxs"></div>
      <div class="legend">
        <span><i style="background:var(--go)"></i>HOT(≥3回)</span>
        <span><i style="background:var(--warm)"></i>WARM</span>
        <span><i style="background:var(--cold)"></i>COLD</span>
        <span><i style="background:#fff;border-radius:50%;width:6px;height:6px;display:inline-block;margin-right:4px"></i>resident</span>
      </div>
    </div>
    <div class="card">
      <h3>AI モデルによる書き込み（Context Cache）</h3>
      <div class="caches" id="caches"><span style="color:var(--mute)">まだ書き込みなし</span></div>
    </div>
    <div class="card">
      <h3>ライブイベント</h3>
      <div class="log" id="log"></div>
    </div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
const msgs = $('msgs'), inp = $('inp'), sendBtn = $('send');
let busy = false;

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function addMsg(role, text, meta) {
  const d = document.createElement('div');
  d.className = 'bubble ' + role;
  d.innerHTML = esc(text);
  if (meta) d.innerHTML += '<div class="meta">' + esc(meta) + '</div>';
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

async function send() {
  const text = inp.value.trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  inp.value = '';
  addMsg('user', text);
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const d = await r.json();
    if (d.error) { addMsg('ai', '⚠️ ' + d.error); }
    else { addMsg('ai', d.reply, d.expert + ' · ' + d.model + ' · ' + d.kind + ' · ' + d.ms + 'ms'); }
  } catch (e) { addMsg('ai', '⚠️ ' + e); }
  busy = false; sendBtn.disabled = false;
  inp.focus();
}
$('send').addEventListener('click', send);
inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

// ─── AVM 可視化（2 秒ごとに /api/avm をポーリング）──────────────────
async function refreshAvm() {
  try {
    const r = await fetch('/api/avm');
    const a = await r.json();
    $('s-read').textContent = a.stats.reads;
    $('s-write').textContent = a.stats.writes;
    $('s-call').textContent = a.stats.modelCalls;
    $('s-resident').textContent = a.stats.residentPages;
    $('s-bytes').textContent = a.stats.residentBytes >= 1024 ? (a.stats.residentBytes/1024).toFixed(1)+' KB' : a.stats.residentBytes + ' B';
    $('s-cache').textContent = a.caches.length;
    // コンテキスト × ページマップ
    $('ctxs').innerHTML = a.contexts.map(c => {
      const pages = a.pages.filter(p => p.contextTitle === c.title).sort((x,y)=>x.index-y.index);
      const cells = pages.map(p =>
        '<span class="page ' + p.tier + (p.resident ? ' resident' : '') + '" title="p' + p.index + ' · ' + p.chars + 'chars · ' + p.tier + (p.resident?' · resident':'') + '">' + p.index + '</span>'
      ).join('');
      return '<div class="ctx"><div class="name">' + esc(c.title) + ' <span class="meta">' + c.chars + ' chars / ' + c.pageCount + ' pages / resident ' + c.residentPages + '</span></div>' +
        '<div class="pages">' + cells + '</div></div>';
    }).join('') || '<span style="color:var(--mute)">AVM にコンテキストがありません</span>';
    // キャッシュ（モデル書き込み）
    $('caches').innerHTML = a.caches.length
      ? a.caches.map(c => '<div class="cache"><span class="k">' + esc(c.kind) + ':' + esc(c.key) + '</span><span class="v">' + esc(c.actor) + ' · ' + c.chars + ' chars</span></div>').join('')
      : '<span style="color:var(--mute)">まだ書き込みなし</span>';
    // イベントログ
    $('log').innerHTML = a.events.map(e =>
      '<div class="ev k-' + esc(e.kind) + '"><span class="t">' + new Date(e.ts).toLocaleTimeString('ja-JP',{hour12:false}) + '</span><span class="a">' + esc(e.actor) + '</span><span class="d">' + esc(e.detail) + '</span></div>'
    ).join('') || '<div style="color:var(--mute)">イベント待ち…</div>';
  } catch (_) {}
}
setInterval(refreshAvm, 2000);
refreshAvm();
addMsg('ai', 'こんにちは。ArcAsha（AI オペレーティングシステム）です。AVM（仮想メモリ）経由で実モデルと対話します。右パネルでメモリの読み書きを確認できます。', 'system · 起動メッセージ');
</script>
</body>
</html>`;

// ─── HTTP サーバ ────────────────────────────────────────────────────
// セキュリティ: ループバックにのみバインド。認証トークンは ARCASHA_API_TOKEN で任意設定。
const apiToken = process.env.ARCASHA_API_TOKEN ?? '';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  // CORS: ローカルオリジンのみ許可（外部サイトからの読み取りを防ぐ）
  const origin = req.headers.origin;
  const allowOrigin =
    origin && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))
      ? origin
      : 'http://localhost:4780';
  const sendJson = (code: number, obj: unknown) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end(body);
  };
  const readBody = () =>
    new Promise<string>((resolve, reject) => {
      let buf = '';
      req.on('data', (c) => {
        buf += c;
        if (buf.length > 1_000_000) {
          reject(new Error('request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(buf));
      req.on('error', (e) => reject(e));
      req.on('aborted', () => reject(new Error('request aborted')));
    });

  if (req.method === 'OPTIONS') { sendJson(204, {}); return; }

  // 認証（ARCASHA_API_TOKEN 設定時は /api/* と /v1/* に Bearer 必須）
  if (apiToken && url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
    if (req.headers.authorization !== `Bearer ${apiToken}`) {
      sendJson(401, { error: 'unauthorized: ARCASHA_API_TOKEN が必要です' });
      return;
    }
  }
  if (apiToken && url.pathname.startsWith('/v1/')) {
    if (req.headers.authorization !== `Bearer ${apiToken}`) {
      sendJson(401, { error: { message: 'unauthorized: ARCASHA_API_TOKEN が必要です' } });
      return;
    }
  }

  // チャット WebUI
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ─── OpenAI 互換 API（Cursor 等が接続するエンドポイント）───────────
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      const body = JSON.parse(await readBody());
      const messages: Array<{ role: string; content: string }> = Array.isArray(body.messages) ? body.messages : [];
      const last = [...messages].reverse().find((m) => m.role === 'user');
      if (!last) { sendJson(400, { error: { message: 'messages に user メッセージが必要です' } }); return; }
      // 未知のモデルは 400 で拒否（/v1/models の公開モデルのみ受理）
      const reqModel = String(body.model ?? '');
      if (reqModel && !hub.experts.some((e) => e.modelId === reqModel)) {
        sendJson(400, { error: { message: `unknown model: ${reqModel}（利用可能: ${hub.experts.map((e) => e.modelId).join(', ')}）` } });
        return;
      }
      const maxTokens = Number(body.max_tokens) > 0 ? Number(body.max_tokens) : DEFAULT_MAX_TOKENS;
      // 受信した messages 全体を会話として AVM へ（サーバー側共有履歴とは結合しない）
      const title = `api:${shortHash(messages.map((m) => `${m.role}:${m.content}`).join('|'))}`;
      const r = await answerConversation(title, messages as { role: 'user' | 'assistant'; content: string }[], maxTokens);
      const usage = hub.lastApiUsage;
      const promptTokens = usage?.promptTokens ?? Math.ceil(last.content.length / 4);
      const completionTokens = usage?.completionTokens ?? Math.ceil(r.reply.length / 4);
      sendJson(200, {
        id: `chatcmpl-arcasha-${msgSeq}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: r.model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.reply }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        _arcasha: { ms: r.ms, nodeId: r.nodeId, model: r.model, kind: r.kind, expert: r.expert, trace: r.trace, avm: ws.snapshot(40) },
      });
    } catch (e) {
      sendJson(500, { error: { message: String(e) } });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(200, {
      object: 'list',
      data: hub.experts.map((e) => ({ id: e.modelId, object: 'model', owned_by: 'arcasha' })),
    });
    return;
  }

  // ─── 内部 REST API ─────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const body = JSON.parse(await readBody());
      const message = String(body.message ?? '').trim();
      if (!message) { sendJson(400, { error: 'message が空です' }); return; }
      const maxTokens = Number(body.maxTokens) > 0 ? Number(body.maxTokens) : DEFAULT_MAX_TOKENS;
      // WebUI の会話は単一ユーザー前提。ロックで直列化し、履歴は上限で切り詰める
      const r = await withLock(async () => {
        history.push({ role: 'user', content: message });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
        const res = await answerConversation('会話', history, maxTokens);
        history.push({ role: 'assistant', content: res.reply });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
        return res;
      });
      sendJson(200, { ...r, events: ws.snapshot(40).events });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/knowledge') {
    try {
      const body = JSON.parse(await readBody());
      const title = String(body.title ?? '知識').trim() || '知識';
      const text = String(body.text ?? '');
      if (!text) { sendJson(400, { error: 'text が空です' }); return; }
      ws.storeContext(title, text, 'user');
      sendJson(200, { ok: true, title, chars: text.length, snapshot: ws.snapshot(20) });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }

  const parseLimit = (raw: string | null, fallback = 120): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  if (req.method === 'GET' && url.pathname === '/api/avm') {
    sendJson(200, ws.snapshot(parseLimit(url.searchParams.get('limit'))));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/avm/events') {
    sendJson(200, { events: ws.snapshot(parseLimit(url.searchParams.get('limit'))).events });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/nodes') {
    sendJson(200, {
      nodes: hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(200, {
      ok: true,
      model,
      node: pickNode(),
      nodes: hub.experts.length,
      history: history.length,
      avm: ws.snapshot(0).stats,
    });
    return;
  }

  sendJson(404, { error: `not found: ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  ArcAsha Chat Server');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  WebUI (Chat + AVM 可視化) : http://localhost:${PORT}/`);
  console.log(`  OpenAI 互換 API            : http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  AVM スナップショット       : http://localhost:${PORT}/api/avm`);
  console.log(`  エキスパート艦隊           : ${fleet.map((e) => `${e.label}=${e.model}`).join(' / ') || 'mock'}`);
  console.log('');
  console.log('  Cursor 等からは baseURL を http://localhost:' + PORT + '/v1 に設定してください');
  console.log('');
});
