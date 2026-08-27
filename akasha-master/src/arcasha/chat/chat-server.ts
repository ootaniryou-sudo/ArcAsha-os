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
const DEFAULT_MAX_TOKENS = 256;

// ─── ノード（ExpertHub）───────────────────────────────────────────────
const hub = new ExpertHub();
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
const base = (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const key = process.env.DEEPSEEK_API_KEY ?? '';

// 実モデル（DeepSeek）を優先登録。無ければモックを 2 台（UI/API は動く）
let mainNodeId = '';
if (key) {
  mainNodeId = 'api-deepseek';
  hub.addApiNode(mainNodeId, base, key, model);
  console.log(`  ☁️ 実モデル接続: ${mainNodeId} (${model} @ ${base})`);
} else {
  console.log('  ⚠️ DEEPSEEK_API_KEY が無いためモックノードで動作します（実タスクには .env を設定）');
  hub.addMockNode('mock-a', 'HuggingFaceTB/SmolLM2-135M-Instruct');
  hub.addMockNode('mock-b', 'HuggingFaceTB/SmolLM2-135M-Instruct');
  mainNodeId = hub.experts[0]?.nodeId ?? '';
}

function pickNode(): string {
  if (hub.experts.some((e) => e.nodeId === mainNodeId)) return mainNodeId;
  return hub.experts[0]?.nodeId ?? '';
}

// ─── AVM ワークスペース + 会話履歴 ────────────────────────────────────
const ws = new AvmWorkspace();
const history: { role: 'user' | 'assistant'; content: string }[] = [];
let msgSeq = 0;

/** 会話履歴を AVM の「会話」コンテキストへ書き込み、テキストとして返す */
function conversationText(): string {
  return history
    .map((m, i) => `${m.role === 'user' ? 'Q' : 'A'}[${i}]: ${m.content}`)
    .join('\n');
}

/**
 * チャット 1 ターンを実行する（AVM 経由）:
 *   1. 会話を AVM に書く（context.write, actor=user）
 *   2. search expert が会話の必要ページだけを読む（slice.read / tier.move）
 *   3. 実モデルを呼び出して回答（model.call）
 *   4. 回答を AVM に書き戻す（cache.write, actor=モデル）← 「AIモデルによる書き込み」
 */
async function answer(message: string, maxTokens = DEFAULT_MAX_TOKENS): Promise<{
  reply: string;
  ms: number;
  model: string;
  nodeId: string;
  trace: string[];
}> {
  const trace: string[] = [];
  const t0 = Date.now();

  // 1) 会話を AVM へ書く
  history.push({ role: 'user', content: message });
  ws.storeContext('会話', conversationText(), 'user');
  trace.push('context.write 会話');

  // 2) search expert が AVM から必要ページを読む（会話 + 知識コンテキスト）
  const load = ws.readSlice('会話', 'search', message, 'search');
  const kloads = ws.searchKnowledge(message, 2, 'search');
  const contextSnippet =
    [
      load && load.loadedText ? `[会話] ${load.loadedText.slice(0, 800)}` : '',
      ...kloads.map((k) => `[知識:${k.title}] ${k.loadedText.slice(0, 800)}`),
    ].filter(Boolean).join('\n') || '(履歴なし)';
  trace.push(`slice.read search (${load?.pageIds.length ?? 0} pages / 知識 ${kloads.length} contexts)`);

  // 3) 実モデル呼び出し
  const nodeId = pickNode();
  const prompt = [
    'あなたは ArcAsha（AI オペレーティングシステム）の上で動くモデルです。',
    '以下は AVM（AI 仮想メモリ）から読み込んだ会話コンテキストです:',
    '─── context ───',
    contextSnippet,
    '──────────────',
    `質問: ${message}`,
    '簡潔に日本語で答えてください。',
  ].join('\n');
  const genT0 = Date.now();
  let reply = '';
  try {
    const text = await hub.generate(nodeId, prompt, maxTokens);
    reply = String(text ?? '').trim();
  } catch (e) {
    reply = `⚠️ モデル呼び出し失敗: ${String(e).slice(0, 200)}`;
  }
  const genMs = Date.now() - genT0;
  ws.recordModelCall(model, genMs, `${nodeId} へ ${maxTokens} tokens 上限で生成`);
  trace.push(`model.call ${model} (${genMs}ms)`);

  // 4) 回答を AVM に書き戻す（AI モデルの書き込み）
  msgSeq++;
  ws.writeCache('会話', 'summary', `answer:${msgSeq}`, reply, model);
  trace.push('cache.write 回答');

  history.push({ role: 'assistant', content: reply });
  return { reply, ms: Date.now() - t0, model, nodeId, trace };
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
    else { addMsg('ai', d.reply, d.model + ' · ' + d.nodeId + ' · ' + d.ms + 'ms'); }
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const sendJson = (code: number, obj: unknown) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    res.end(body);
  };
  const readBody = () =>
    new Promise<string>((resolve) => {
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > 1_000_000) req.destroy(); });
      req.on('end', () => resolve(buf));
    });

  if (req.method === 'OPTIONS') { sendJson(204, {}); return; }

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
      const maxTokens = Number(body.max_tokens) > 0 ? Number(body.max_tokens) : DEFAULT_MAX_TOKENS;
      const r = await answer(last.content, maxTokens);
      const usage = hub.lastApiUsage;
      sendJson(200, {
        id: `chatcmpl-arcasha-${msgSeq}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: r.model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.reply }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage?.promptTokens ?? Math.ceil(last.content.length / 4),
          completion_tokens: usage?.completionTokens ?? Math.ceil(r.reply.length / 4),
          total_tokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0) + Math.ceil((last.content.length + r.reply.length) / 4),
        },
        _arcasha: { ms: r.ms, nodeId: r.nodeId, trace: r.trace, avm: ws.snapshot(40) },
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
      const r = await answer(message, maxTokens);
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

  if (req.method === 'GET' && url.pathname === '/api/avm') {
    sendJson(200, ws.snapshot(Number(url.searchParams.get('limit') ?? 120)));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/avm/events') {
    sendJson(200, { events: ws.snapshot(Number(url.searchParams.get('limit') ?? 120)).events });
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

server.listen(PORT, () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  ArcAsha Chat Server');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  WebUI (Chat + AVM 可視化) : http://localhost:${PORT}/`);
  console.log(`  OpenAI 互換 API            : http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  AVM スナップショット       : http://localhost:${PORT}/api/avm`);
  console.log(`  モデル                    : ${model} @ ${pickNode()}`);
  console.log('');
  console.log('  Cursor 等からは baseURL を http://localhost:' + PORT + '/v1 に設定してください');
  console.log('');
});
