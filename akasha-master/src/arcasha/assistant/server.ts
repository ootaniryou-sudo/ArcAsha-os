#!/usr/bin/env npx tsx
/**
 * ArcAsha Assistant — 手軽な AI アシスタント（Hermes Agent 風）
 *
 * 専門知識なしの一般ユーザーが日常タスクにすぐ使える、オーケストレーション統合
 * アシスタント。DeepSeek の Web UI / Hermes Agent のようなリッチな画面を目指す。
 *
 * 機能:
 *  1) リッチな Chat WebUI（サイドバー: スレッド一覧・記憶・知識 / モード切替）
 *     - casual（カジュアル）: 自然言語で日常タスク。長期記憶を自動活用
 *     - expert（エキスパート）: スラッシュコマンドで高度な操作
 *  2) 長期記憶層（LongTermMemory）: スレッド・ユーザー記憶・知識を JSON 永続化
 *  3) OpenAI 互換 API: /v1/chat/completions + /v1/models（Cursor 等から接続可）
 *  4) 複数モデル連携（model-fleet）: タスク分類 → Flash / Pro を自動ルーティング
 *  5) 高度モード: スラッシュコマンド（/remember /forget /expert /casual /pin 等）
 *
 * 使い方:
 *   npx tsx src/arcasha/assistant/server.ts            # http://localhost:4781
 *   env ARCASHA_ASSISTANT_PORT=9000 npx tsx ...
 * 必要なら DEEPSEEK_API_KEY を .env に設定（無ければモックで動作）
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import http from 'node:http';
import { ExpertHub } from '../experts/registry.js';
import { AvmWorkspace } from '../chat/avm-telemetry.js';
import { buildFleet, classifyTask, routeExpert } from '../plugin/model-fleet.js';
import { LongTermMemory } from './long-term-memory.js';
import { promises as fs } from 'node:fs';
import { chatCompletion, chatDefaults } from '../swe/model.js';
import { runSweAgent } from '../swe/agent.js';
import { extractRememberAll } from './remember.js';
import { SettingsStore, maskSecret } from './settings.js';
import type { FleetExpert } from '../plugin/model-fleet.js';
import { compile as ailsmCompile } from '../ailsm/compiler.js';
import { nameOf, loadRegistry } from '../ailsa/vocab.js';

// .env を cwd 非依存で読み込む（akasha-master/.env を起点に解決 → cwd フォールバック）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../../.env') });
loadEnv();

// ─── 設定 ─────────────────────────────────────────────────────────
let PORT = Number(process.env.ARCASHA_ASSISTANT_PORT ?? 4781);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') {
    const v = Number(args[++i]);
    if (Number.isInteger(v) && v > 0) PORT = v;
  }
}
const DEFAULT_MAX_TOKENS = 1500;
const HYPER_MAX_TOKENS = 8000; // ハイパー Thinking 時は推論枠を広げる
const apiToken = process.env.ARCASHA_API_TOKEN ?? '';
// Coding Agent（実ファイル編集）の作業ディレクトリ。env で上書き可能。
const AGENT_WORKDIR = path.resolve(process.env.ARCASHA_WORKDIR ?? process.cwd());
const AGENT_ALLOW_RUN = process.env.ARCASHA_AGENT_ALLOW_RUN === '1';

// ─── ノード（複数モデル艦隊）+ AVM + 長期記憶 + 設定 ─────────────
const hub = new ExpertHub();
const fleet = buildFleet(hub, { verbose: true });
const ws = new AvmWorkspace();
const memory = new LongTermMemory();
const settings = new SettingsStore();
await memory.load();
await settings.load();

/**
 * オーケストレーションに参加するモデル艦隊を設定から構築する。
 * orchestrationCount = 参加モデル数（1〜50）。
 *   - 1: Flash（general）1 台
 *   - 2: Flash + Pro（既定）
 *   - 3〜50: 推論ノードを増やしてフォールバックチェーンを長くする
 * customModel（「その他」で入力したモデル名）があれば推論ノードのモデルになる。
 */
function activeFleet(): FleetExpert[] {
  const s = settings.get();
  // 設定の API キー or env キーがあれば実モデル接続として扱う（起動時に fleet がモックでも設定で接続できる）
  const hasAnyKey = s.apiKey !== '' || process.env.DEEPSEEK_API_KEY !== '';
  const fGeneral = fleet.find((e) => e.role === 'general');
  const fReasoning = fleet.find((e) => e.role === 'reasoning');
  const generalModel = hasAnyKey ? (s.model || 'deepseek-v4-flash') : (fGeneral?.model ?? 'mock');
  const reasoningModel = hasAnyKey
    ? (s.customModel || process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro')
    : (fReasoning?.model ?? generalModel);
  const list: FleetExpert[] = [{
    nodeId: fGeneral?.nodeId ?? 'general',
    model: generalModel,
    role: 'general' as const,
    label: hasAnyKey ? 'Flash（汎用）' : (fGeneral?.label ?? 'Flash'),
  }];
  for (let i = 1; i < s.orchestrationCount; i++) {
    list.push({
      nodeId: (fReasoning?.nodeId ?? 'reasoning') + (i > 1 ? `-${i}` : ''),
      model: reasoningModel,
      role: 'reasoning' as const,
      label: (hasAnyKey ? 'Pro（推論）' : (fReasoning?.label ?? 'Pro')) + (i > 1 ? ` #${i}` : ''),
    });
  }
  return list;
}

// 現在選択中スレッド（WebUI 用・シングルユーザー前提）
let currentThreadId: string | null = null;
function currentThread(): string {
  if (!currentThreadId || !memory.getThread(currentThreadId)) {
    currentThreadId = memory.createThread({ mode: 'casual' }).id;
  }
  return currentThreadId;
}

/**
 * カジュアル応答 1 ターン。
 * 長期記憶（facts / knowledge）+ AVM のコンテキストを組み合わせて回答する。
 * ユーザーが自分について話した自己紹介文は、ルールで確実に記憶へ保存する。
 */
async function answerThread(
  threadId: string,
  opts: { maxTokens?: number; mode?: 'casual' | 'expert'; injectFact?: boolean; model?: string; systemPrompt?: string } = {},
): Promise<{
  reply: string;
  ms: number;
  model: string;
  kind: string;
  expert: string;
  trace: string[];
  remembered?: { text: string; category: string };
  ailsm?: unknown;
}> {
  const t0 = Date.now();
  const trace: string[] = [];
  const thread = memory.getThread(threadId);
  if (!thread) throw new Error('thread not found');
  const messages = thread.messages;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const query = lastUser?.content ?? '';
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const mode = opts.mode ?? thread.mode;
  const s = settings.get();

  // タスク分類 → 担当モデル（設定のオーケストレーション数に従う）
  const orchestration = activeFleet();
  const kind = classifyTask(query);
  const expert = routeExpert(kind, orchestration);
  trace.push(`classify → ${kind}（担当: ${expert.label} / ${expert.model}）`);
  trace.push(`orchestration: ${orchestration.map((e) => `${e.role}=${e.model}`).join(' + ')} 件数 ${orchestration.length}`);

  // 1) 長期記憶コンテキスト（ユーザーについて・知識・直近会話）
  const memCtx = memory.buildMemoryContext(query, threadId, { recent: 10, factMax: 6, knowMax: 4 });
  ws.storeContext(`thread:${threadId}`, memCtx || '(記憶なし)', 'user');
  trace.push(memCtx ? 'memory.load（facts/knowledge を読込）' : 'memory.load（該当なし）');

  // 2) AVM 知識検索も併用
  const kloads = ws.searchKnowledge(query, 2, 'assistant');
  if (kloads.length > 0) trace.push(`avm.knowledge ×${kloads.length}`);

  const system =
    opts.systemPrompt ??
    (mode === 'expert'
      ? 'あなたは ArcAsha（AI OS）のエキスパートアシスタントです。技術的な質問には正確に、コードは簡潔に答えます。'
      : 'あなたは ArcAsha（AI OS）のやさしい AI アシスタントです。専門知識がない一般ユーザーが相手なので、難しい用語は避け、日常タスク（文章・要約・相談・調べごと・アイデア出しなど）を手助けします。');

  const userBody = [
    '─── 長期記憶（あなたについて / 教えられた知識 / 直近の会話）───',
    memCtx || '（まだ記憶はありません）',
    '──────────────────────────────',
    kloads.length > 0 ? `[AVM知識] ${kloads.map((k) => `${k.title}: ${k.loadedText.slice(0, 300)}`).join('\n')}` : '',
    '',
    `質問: ${query}`,
    '簡潔に・親しみやすく日本語で答えてください。',
  ].join('\n');

  // 実モデル接続か: env キーに加えて設定タブの API キーでも実接続になる
  // （deepseek-v4 は既定 thinking 有効のため、通常は thinking を無効化して確実に content を返す）
  // ハイパー Thinking モードでは逆に thinking + reasoning_effort=max を使う。
  const realModel = settings.get().apiKey !== '' || process.env.DEEPSEEK_API_KEY !== '' || fleet.some((e) => e.model !== 'mock');
  const hyper = s.hyperThinking;
  const genT0 = Date.now();
  let reply = '';
  let usedExpert = expert;
  let reasoningUsed = '';
  // 明示モデル指定（WebUI のモデル選択）があれば chatOpts の model を上書き
  const requestedModel = opts.model ?? '';
  const callModel = async (node: { model: string; nodeId: string }): Promise<{ text: string; reasoning: string }> => {
    if (realModel) {
      const chatOpts = { ...chatDefaults(), timeoutMs: 240_000 };
      // 設定: API キー / ベース URL（設定が空なら .env 既定のまま）
      if (s.apiKey) chatOpts.apiKey = s.apiKey;
      if (s.apiBase) chatOpts.baseUrl = s.apiBase;
      chatOpts.model = requestedModel || node.model;
      chatOpts.maxTokens = hyper ? HYPER_MAX_TOKENS : maxTokens;
      chatOpts.temperature = 0.3;
      if (hyper) {
        chatOpts.thinking = 'enabled';
        chatOpts.reasoningEffort = 'max';
      } else {
        chatOpts.thinking = 'disabled';
      }
      const r = await chatCompletion(
        [
          { role: 'system', content: system },
          { role: 'user', content: userBody },
        ],
        [],
        chatOpts,
      );
      return { text: (r.message.content ?? '').trim(), reasoning: (r.message.reasoning ?? '').trim() };
    }
    return { text: String((await hub.generate(node.nodeId, [system, '', userBody].join('\n'), maxTokens)) ?? '').trim(), reasoning: '' };
  };

  // フォールバックチェーン: 担当 → 艦隊の残りノードを順に試す（参加モデル数の制御）
  const chain = [expert, ...orchestration.filter((e) => e !== expert)];
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    try {
      const out = await callModel(node);
      reply = out.text;
      reasoningUsed = out.reasoning;
      if (reply !== '') {
        usedExpert = node;
        if (i > 0) trace.push(`フォールバック #${i}: ${node.label}`);
        break;
      }
      if (i === 0) trace.push(`空応答 → フォールバック: ${node.label}`);
    } catch (e) {
      trace.push(`⚠️ ${node.label} 失敗: ${String(e).slice(0, 80)}`);
      if (i === chain.length - 1) reply = `⚠️ モデル呼び出し失敗: ${String(e).slice(0, 200)}`;
    }
  }
  // ハイパー Thinking: content が空でも reasoning が得られていれば返す
  if (reply === '' && reasoningUsed !== '') {
    reply = reasoningUsed;
    trace.push('hyper-thinking: reasoning を回答として採用');
  }
  if (reply === '') reply = '（応答が空でした。もう一度お試しください）';
  const genMs = Date.now() - genT0;
  ws.recordModelCall(usedExpert.model, genMs, `${usedExpert.nodeId} へ ${hyper ? HYPER_MAX_TOKENS : maxTokens} tokens 上限で生成${hyper ? '（hyper thinking）' : ''}`);
  trace.push(`model.call ${usedExpert.model} (${genMs}ms)${hyper ? ' [hyper]' : ''}`);

  // 3) 自己紹介・好みをルール抽出 → 長期記憶へ保存
  const rememberedList = extractRememberAll(query, (key) => memory.listFacts().some((f) => f.text.includes(key)));
  for (const r of rememberedList) {
    memory.addFact(r.text, r.category, threadId);
    trace.push(`memory.save fact（${r.category}）: ${r.text}`);
  }
  const remembered = rememberedList[0];

  // 4) AILSM 出力（自然言語 → AILSM コンパイル結果）をメッセージ meta に保存
  //    既に終わった Chat でも、スレッドを開けば AILSM 出力を確認できる。
  const ailsm = ailsmForMeta(query);

  // 5) 回答を AVM キャッシュ + 長期記憶スレッドへ
  ws.writeCache(`thread:${threadId}`, 'summary', `answer:${Date.now()}`, reply, usedExpert.model);
  memory.appendMessage(threadId, { role: 'assistant', content: reply, meta: { model: usedExpert.model, mode, ms: Date.now() - t0, ailsm } });

  return { reply, ms: Date.now() - t0, model: usedExpert.model, kind, expert: usedExpert.label, trace, remembered, ailsm };
}

/**
 * テキストを AILSM コンパイルして UI 表示用の形にする（失敗しても例外にしない）。
 * 戻り値は StoredMessage.meta.ailsm にそのまま保存できる JSON 安全な構造。
 */
function ailsmForMeta(text: string): unknown {
  try {
    const r = ailsmCompile(text);
    return {
      ok: true,
      confidence: r.confidence,
      instructionCount: r.instructions.length,
      instructions: r.instructions.map((i) => ({
        opcode: i.opcode,
        name: nameOf(i.opcode),
        slots: (i.slots ?? []).map((sl) => ({
          slot: sl.slot,
          name: nameOf(sl.slot),
          value: sl.value,
        })),
      })),
      verification: { valid: r.verification.valid, issues: r.verification.issues.length },
      bytesHex: [...r.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '),
      notes: r.notes.slice(0, 8),
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// ─── スラッシュコマンド（エキスパートモード）──────────────────────
async function runCommand(cmd: string, threadId: string): Promise<{ reply: string; trace?: string[]; reload?: boolean; newThreadId?: string }> {
  const [name, ...rest] = cmd.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (name) {
    case 'expert':
      memory.setMode(threadId, 'expert');
      return { reply: '🔧 エキスパートモードに切り替えました。高度な操作ができます。', reload: true };
    case 'casual':
      memory.setMode(threadId, 'casual');
      return { reply: '💬 カジュアルモードに切り替えました。日常タスクなら何でもどうぞ。', reload: true };
    case 'remember':
      if (!arg) return { reply: '使い方: /remember <覚えておく事柄>' };
      memory.addFact(arg, /好き|嫌い|趣味/.test(arg) ? 'preference' : 'user', threadId);
      return { reply: `🧠 覚えました: ${arg}` };
    case 'forget':
      // /forget <id> または /forget all
      if (arg === 'all') {
        for (const f of memory.listFacts()) memory.deleteFact(f.id);
        for (const k of memory.listKnowledge()) memory.deleteKnowledge(k.id);
        return { reply: '🧹 記憶と知識をすべて削除しました。' };
      }
      if (arg) {
        if (memory.deleteFact(arg)) return { reply: `🧹 記憶 ${arg} を削除しました。` };
        if (memory.deleteKnowledge(arg)) return { reply: `🧹 知識 ${arg} を削除しました。` };
        return { reply: `⚠️ ${arg} が見つかりません。/memory で ID を確認してください。` };
      }
      return { reply: '使い方: /forget <id|all>' };
    case 'memory':
      return {
        reply:
          '🧠 記憶一覧\n' +
          (memory.listFacts().length === 0 ? '（ユーザー記憶なし）\n' : memory.listFacts().map((f) => `- [${f.category}] ${f.text} （id: ${f.id}）`).join('\n') + '\n') +
          (memory.listKnowledge().length === 0 ? '（知識なし）' : '📚 知識:\n' + memory.listKnowledge().map((k) => `- ${k.title}（id: ${k.id}）`).join('\n')),
      };
    case 'pin':
      memory.togglePinned(threadId);
      return { reply: '📌 スレッドをピン留め/解除しました。', reload: true };
    case 'help':
      return {
        reply:
          '🔧 エキスパートコマンド一覧\n' +
          '- `/expert` / `/casual` — モード切替\n' +
          '- `/remember <事柄>` — ユーザー記憶に追加\n' +
          '- `/forget <id|all>` — 記憶・知識を削除\n' +
          '- `/memory` — 記憶と知識の一覧\n' +
          '- `/pin` — スレッドをピン留め\n' +
          '- `/new` — 新しい会話を開始\n' +
          'OpenAI 互換 API は `POST /v1/chat/completions`（baseURL は本サーバの /v1）',
      };
    case 'new': {
      // 新しいスレッドを作って切り替え（UI が newThreadId で切替できるように返す）
      const nt = memory.createThread({ mode: 'expert' });
      currentThreadId = nt.id;
      return { reply: '🆕 新しい会話を開始しました。', reload: true, newThreadId: nt.id };
    }
    default:
      return { reply: `⚠️ 不明なコマンド: /${name}（/help で一覧）` };
  }
}

// ─── HTTP サーバ ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const origin = req.headers.origin;
  // CORS: ローカルホスト（localhost / 127.0.0.1 / ::1）の同ポートのみ許可。
  // プレフィックス一致ではなくホスト名・ポートを厳密に検証する（localhost.evil.com 等を弾く）。
  const defaultOrigin = `http://localhost:${PORT}`;
  const allowOrigin = ((): string => {
    if (!origin) return defaultOrigin;
    try {
      const u = new URL(origin);
      const okHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
      if (okHost && u.port === String(PORT)) return origin;
    } catch {
      /* 不正な Origin は許可しない */
    }
    return defaultOrigin;
  })();
  const sendJson = (code: number, obj: unknown) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    });
    res.end(body);
  };
  const readBody = () =>
    new Promise<string>((resolve, reject) => {
      let buf = '';
      req.on('data', (c) => {
        buf += c;
        if (buf.length > 2_000_000) {
          reject(new Error('request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(buf));
      req.on('error', (e) => reject(e));
    });

  if (req.method === 'OPTIONS') {
    sendJson(204, {});
    return;
  }
  // 認証（任意）
  if (apiToken && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) && url.pathname !== '/api/health') {
    if (req.headers.authorization !== `Bearer ${apiToken}`) {
      sendJson(401, { error: { message: 'unauthorized: ARCASHA_API_TOKEN が必要です' } });
      return;
    }
  }

  // ── WebUI（/ /ja /en /zh /ko — 言語別エンドポイント） ──
  const langMatch = url.pathname.toLowerCase().match(/^\/(ja|en|zh|ko)$/);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || langMatch)) {
    try {
      const html = await fs.readFile(path.resolve(__dirname, 'ui.html'), 'utf8');
      // UI ロケール: /ja /en /zh /ko が優先、無ければ設定の言語
      const locale = langMatch ? langMatch[1] : settings.get().language;
      let localized = html.replace('const UI_LOCALE = "__LOCALE__";', `const UI_LOCALE = "${locale}";`);
      // ARCASHA_API_TOKEN 設定時は UI の fetch 用トークンを注入（認証ミドルウェアと対になる）
      localized = localized.replace('const UI_API_TOKEN = "__API_TOKEN__";', `const UI_API_TOKEN = ${JSON.stringify(apiToken)};`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(localized);
    } catch (e) {
      sendJson(500, { error: `ui.html 読込失敗: ${String(e).slice(0, 200)}` });
    }
    return;
  }

  // ── OpenAI 互換 /v1/chat/completions ──
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      const body = JSON.parse(await readBody());
      const messages: Array<{ role: string; content: string }> = Array.isArray(body.messages) ? body.messages : [];
      const last = [...messages].reverse().find((m) => m.role === 'user');
      if (!last) {
        sendJson(400, { error: { message: 'messages に user メッセージが必要です' } });
        return;
      }
      const reqModel = String(body.model ?? '');
      if (reqModel && !hub.experts.some((e) => e.modelId === reqModel)) {
        sendJson(400, { error: { message: `unknown model: ${reqModel}` } });
        return;
      }
      const maxTokens = Number(body.max_tokens) > 0 ? Number(body.max_tokens) : DEFAULT_MAX_TOKENS;
      // API 用の一時スレッド（履歴を長期記憶に残さない・中断されても永続化されない）
      const tmp = memory.createThread({ mode: body.mode === 'expert' ? 'expert' : 'casual', ephemeral: true });
      for (const m of messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          memory.appendMessage(tmp.id, { role: m.role, content: String(m.content ?? '') });
        }
      }
      // system メッセージは破棄せず、先頭のものをシステムプロンプトとして使う
      const sysMsg = messages.find((m) => m.role === 'system');
      const r = await answerThread(tmp.id, {
        maxTokens,
        mode: tmp.mode,
        model: reqModel, // /v1/models で公開したモデルを呼び分けられる
        systemPrompt: sysMsg ? String(sysMsg.content) : undefined,
      });
      memory.deleteThread(tmp.id);
      const usage = hub.lastApiUsage;
      const pTok = usage?.promptTokens ?? Math.ceil(last.content.length / 4);
      const cTok = usage?.completionTokens ?? Math.ceil(r.reply.length / 4);
      sendJson(200, {
        id: `chatcmpl-arcasha-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: r.model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.reply }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: pTok,
          completion_tokens: cTok,
          total_tokens: pTok + cTok, // フォールバック値同士で一貫させる
        },
        _arcasha: { ms: r.ms, model: r.model, kind: r.kind, expert: r.expert, trace: r.trace },
      });
    } catch (e) {
      sendJson(500, { error: { message: String(e) } });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(200, { object: 'list', data: hub.experts.map((e) => ({ id: e.modelId, object: 'model', owned_by: 'arcasha' })) });
    return;
  }

  // ── WebUI 用 /api/chat（スレッド対応） ──
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const body = JSON.parse(await readBody());
      const message = String(body.message ?? '').trim();
      if (!message) {
        sendJson(400, { error: 'message が空です' });
        return;
      }
      const threadId = String(body.threadId ?? currentThread()).trim() || currentThread();
      let thread = memory.getThread(threadId);
      if (!thread) {
        thread = memory.createThread({ mode: body.mode === 'expert' ? 'expert' : 'casual' });
      }
      currentThreadId = thread.id;
      memory.appendMessage(thread.id, { role: 'user', content: message });

      // スラッシュコマンド（expert / または常時 help 等）
      if (message.startsWith('/')) {
        const r = await runCommand(message, thread.id);
        if (!r.reply.startsWith('⚠️ 不明なコマンド')) {
          // /new は新スレッドが本体なので、返信は新スレッドに書き、UI に新スレッド ID を返す
          const replyThreadId = r.newThreadId ?? thread.id;
          memory.appendMessage(replyThreadId, { role: 'assistant', content: r.reply, meta: { model: 'command', mode: thread.mode } });
          sendJson(200, { reply: r.reply, threadId: replyThreadId, mode: thread.mode, command: true, reload: r.reload ?? false, newThreadId: r.newThreadId });
          return;
        }
      }

      const r = await answerThread(thread.id, { maxTokens: DEFAULT_MAX_TOKENS, mode: thread.mode, model: String(body.model ?? '') });
      sendJson(200, {
        reply: r.reply,
        threadId: thread.id,
        mode: thread.mode,
        expert: r.expert,
        model: r.model,
        kind: r.kind,
        ms: r.ms,
        remembered: r.remembered,
        trace: r.trace,
        ailsm: r.ailsm,
        settings: { hyperThinking: settings.get().hyperThinking, orchestrationCount: settings.get().orchestrationCount },
      });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }

  // ── Coding Agent（実ファイル編集・SSE ストリーミング） ──
  if (req.method === 'POST' && url.pathname === '/api/agent') {
    try {
      const body = JSON.parse(await readBody());
      const prompt = String(body.prompt ?? body.message ?? '').trim();
      if (!prompt) {
        sendJson(400, { error: 'prompt が空です' });
        return;
      }
      // root は明示指定がない限り AGENT_WORKDIR（env / cwd）。外部ディレクトリは許可しない。
      // プレフィックス一致ではなく path.relative の境界判定を使う（/work/repo-other を弾く）
      let root = AGENT_WORKDIR;
      if (typeof body.root === 'string' && body.root.trim() !== '') {
        root = path.resolve(body.root);
        const rel = path.relative(AGENT_WORKDIR, root);
        const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        if (!inside) {
          sendJson(403, { error: `許可されていない作業ディレクトリです: ${root}` });
          return;
        }
      }
      // 任意コマンド実行はサーバ設定（ARCASHA_AGENT_ALLOW_RUN）だけが決める。リクエストからは有効化できない。
      const allowRun = AGENT_ALLOW_RUN;
      // ループ数はサーバ側の上限（50）でキャップする
      const reqIter = Number(body.maxIterations);
      const maxIterations = Math.min(
        Number.isSafeInteger(reqIter) && reqIter >= 1 ? reqIter : 30,
        50,
      );

      // SSE ヘッダー
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'X-Accel-Buffering': 'no',
      });
      const sse = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sse('start', { root, allowRunCommand: allowRun, prompt });

      try {
        // 設定タブの API キー / Base URL をエージェントにも適用（.env より優先）
        const agentChat: { apiKey?: string; baseUrl?: string } = {};
        if (settings.get().apiKey) agentChat.apiKey = settings.get().apiKey;
        if (settings.get().apiBase) agentChat.baseUrl = settings.get().apiBase;
        const result = await runSweAgent({
          root,
          issue: prompt,
          allowRunCommand: allowRun,
          maxIterations,
          chat: agentChat,
          onStep: (step, index) => {
            sse('step', {
              index,
              message: step.message,
              toolResults: step.toolResults,
              usage: step.usage,
              ms: step.ms,
            });
          },
        });
        sse('done', {
          ok: result.ok,
          finalAnswer: result.finalAnswer,
          toolCalls: result.toolCalls,
          modelCalls: result.modelCalls,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          totalMs: result.totalMs,
          stopReason: result.stopReason,
          root,
        });
      } catch (e) {
        sse('error', { message: String(e) });
      }
      res.end();
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }

  // ── スレッド CRUD ──
  if (req.method === 'POST' && url.pathname === '/api/threads') {
    try {
      const body = JSON.parse(await readBody());
      const mode = body.mode === 'expert' ? 'expert' : 'casual';
      // cloneFrom 指定時は元スレッドのメッセージをコピーした新スレッド（Branch 分岐用）
      if (typeof body.cloneFrom === 'string' && body.cloneFrom) {
        const src = memory.getThread(String(body.cloneFrom));
        if (!src) {
          sendJson(404, { error: 'cloneFrom のスレッドが見つかりません' });
          return;
        }
        const t = memory.createThread({
          title: `${src.title}（分岐）`,
          mode: src.mode,
          messages: src.messages.map((m) => ({ ...m })),
        });
        sendJson(200, { thread: t, cloned: true });
        return;
      }
      const t = memory.createThread({ title: body.title, mode });
      sendJson(200, { thread: t });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }
  const mThread = url.pathname.match(/^\/api\/threads\/([A-Za-z0-9]+)$/);
  if (mThread) {
    const id = mThread[1];
    if (req.method === 'GET') {
      const t = memory.getThread(id);
      if (!t) {
        sendJson(404, { error: 'thread not found' });
        return;
      }
      sendJson(200, { thread: t });
      return;
    }
    if (req.method === 'DELETE') {
      memory.deleteThread(id);
      if (currentThreadId === id) currentThreadId = null;
      sendJson(200, { ok: true });
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody());
        if (typeof body.title === 'string') memory.renameThread(id, body.title);
        if (body.pin === true || body.pin === false) {
          // getThread 経由の直接変更は永続化されないため setPinned mutator を使う
          memory.setPinned(id, body.pin);
        }
        sendJson(200, { ok: true });
      } catch (e) {
        sendJson(500, { error: String(e) });
      }
      return;
    }
  }

  // ── 記憶（facts / knowledge）API ──
  if (req.method === 'GET' && url.pathname === '/api/memory') {
    sendJson(200, { facts: memory.listFacts(), knowledge: memory.listKnowledge(), path: memory.memoryPath() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/facts') {
    try {
      const body = JSON.parse(await readBody());
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendJson(400, { error: 'text が空です' });
        return;
      }
      const f = memory.addFact(text, String(body.category ?? 'user'));
      sendJson(200, { fact: f });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }
  const mFact = url.pathname.match(/^\/api\/facts\/([A-Za-z0-9]+)$/);
  if (mFact && req.method === 'DELETE') {
    memory.deleteFact(mFact[1]);
    sendJson(200, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/knowledge') {
    try {
      const body = JSON.parse(await readBody());
      const title = String(body.title ?? '').trim() || '知識';
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendJson(400, { error: 'text が空です' });
        return;
      }
      const k = memory.addKnowledge(title, text);
      sendJson(200, { knowledge: k });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }
  const mKnow = url.pathname.match(/^\/api\/knowledge\/([A-Za-z0-9]+)$/);
  if (mKnow && req.method === 'DELETE') {
    memory.deleteKnowledge(mKnow[1]);
    sendJson(200, { ok: true });
    return;
  }

  // ── 設定（Settings） ──
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const s = settings.get();
    sendJson(200, {
      ...s,
      apiKey: maskSecret(s.apiKey), // キーはマスクして返す
      hasApiKey: s.apiKey !== '',
      path: settings.path(),
      availableModels: [
        { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
        { id: '__custom__', label: 'その他（カスタム）' },
      ],
    });
    return;
  }
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    try {
      const body = JSON.parse(await readBody()) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      // apiKey がマスク値（•••• を含む）なら変更なしとして無視する
      if (typeof body.apiKey === 'string' && !String(body.apiKey).includes('••••')) patch.apiKey = body.apiKey;
      if (typeof body.apiBase === 'string') patch.apiBase = body.apiBase;
      if (typeof body.model === 'string' && body.model !== '__custom__') patch.model = body.model;
      if (typeof body.customModel === 'string') patch.customModel = body.customModel;
      if (body.orchestrationCount !== undefined) patch.orchestrationCount = Number(body.orchestrationCount);
      if (typeof body.hyperThinking === 'boolean') patch.hyperThinking = body.hyperThinking;
      if (typeof body.language === 'string') patch.language = body.language;
      const s = settings.update(patch);
      sendJson(200, {
        ...s,
        apiKey: maskSecret(s.apiKey),
        hasApiKey: s.apiKey !== '',
        saved: true,
        note: 'API キー・モデル等の変更は次のリクエストから反映されます（サーバ再起動は不要）。',
      });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }

  // ── AILSM 指示語の辞典（registry.json = 唯一の権威） ──
  if (req.method === 'GET' && url.pathname === '/api/ailsm/dictionary') {
    try {
      const reg = loadRegistry();
      sendJson(200, reg);
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }
  // AILSM コンパイル（任意テキスト → AILSM IR / AILSA 命令列）
  if (req.method === 'POST' && url.pathname === '/api/ailsm/compile') {
    try {
      const body = JSON.parse(await readBody());
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendJson(400, { error: 'text が空です' });
        return;
      }
      sendJson(200, { text, ailsm: ailsmForMeta(text) });
    } catch (e) {
      sendJson(500, { error: String(e) });
    }
    return;
  }

  // ── AVM 可視化・状態 ──
  if (req.method === 'GET' && url.pathname === '/api/avm') {
    sendJson(200, ws.snapshot(40));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(200, {
      ok: true,
      port: PORT,
      model: fleet[0]?.model ?? 'mock',
      nodes: fleet.map((e) => ({ label: e.label, model: e.model, role: e.role })),
      currentThreadId,
      threads: memory.listThreads(),
      memoryPath: memory.memoryPath(),
      workdir: AGENT_WORKDIR,
      allowRunCommand: AGENT_ALLOW_RUN,
      models: hub.experts.map((e) => ({ id: e.modelId, nodeId: e.nodeId, family: e.family, paramsM: e.paramsM })),
      settings: {
        language: settings.get().language,
        orchestrationCount: settings.get().orchestrationCount,
        hyperThinking: settings.get().hyperThinking,
        model: settings.get().model,
        customModel: settings.get().customModel,
        hasApiKey: settings.get().apiKey !== '',
      },
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(200, { ok: true, model: fleet[0]?.model ?? 'mock', nodes: fleet.length, threads: memory.listThreads().length });
    return;
  }

  sendJson(404, { error: `not found: ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ArcAsha Assistant — 手軽な AI アシスタント');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  WebUI（チャット + 長期記憶 + モード切替）: http://localhost:${PORT}/`);
  console.log(`  OpenAI 互換 API  : http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  モデル艦隊        : ${fleet.map((e) => `${e.label}=${e.model}`).join(' / ')}`);
  console.log(`  長期記憶          : ${memory.memoryPath()}`);
  console.log(`  （再起動後も記憶は残ります）`);
  console.log('');
  console.log('  Cursor 等からは baseURL を http://localhost:' + PORT + '/v1 に設定してください');
  console.log('');
});
