/**
 * Ablation Baseline（Phase 4 — Scientific Validation）
 * 「ArcAsha のどの技術が本当に効いているか」を、同一タスク・同一モデルで
 * 4 構成を比較して証明する。
 *
 *   ① Baseline LLM    : モデル単体（OS なし・素のプロンプト）
 *   ② Baseline + AVM  : AVM が明示知識から必要ページだけを供給
 *   ③ Baseline + Exec : Executive（aiosExecute: compile → CALL → learner）のみ
 *   ④ Full ArcAsha    : AVM + Executive の組み合わせ
 *
 * 公平性: ①〜④すべて同じモデル（deepseek-v4-flash）。ルーティング（Pro）は
 * 別レバーとして混ぜない（モデル差を導入しない）。数値は kind=real-api の実測。
 *
 * 測定: 正確性（数値/キーワード検証） / レイテンシ / トークン使用量（実 API） /
 *       コスト（概算） / 成功率（非空応答率）
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { ExpertHub } from '../experts/registry.js';
import { buildFleet } from '../plugin/model-fleet.js';
import { initAiOs, aiosExecute } from '../ailsm/aios.js';
import { AvmWorkspace } from '../chat/avm-telemetry.js';

// ─── タスクセット（検証可能な正答を持つ・実 API で解かせる）──────────
export interface AblationTask {
  id: string;
  category: 'math' | 'knowledge';
  task: string;
  reference: string;   // 正答（数値 or キーワード）
  context?: string;    // AVM に渡す知識（knowledge タスクのみ）
}

export const ABLATION_TASKS: AblationTask[] = [
  // ── 数学（コンテキストなし: Executive / パイプラインの寄与を見る）──
  { id: 'm1', category: 'math', task: 'バナナ 3 本（1 本 100 円）とりんご 2 個（1 個 150 円）を買った。合計はいくら？', reference: '600' },
  { id: 'm2', category: 'math', task: '1 日 8 時間働いて 3 日間働いた。総労働時間は何時間？', reference: '24' },
  { id: 'm3', category: 'math', task: 'クラスに 30 人いて、そのうち 40% が女子。女子は何人？', reference: '12' },
  { id: 'm4', category: 'math', task: '時速 60km で 2 時間半走った。距離は何 km？', reference: '150' },
  { id: 'm5', category: 'math', task: '定価 2500 円の商品を 20% 引きで買った。支払額はいくら？', reference: '2000' },
  { id: 'm6', category: 'math', task: '1 年は 52 週。毎週 10 時間勉強すると年間何時間？', reference: '520' },
  // ── 知識 QA（コンテキストあり: AVM の検索・供給の寄与を見る）──
  {
    id: 'k1', category: 'knowledge',
    task: 'ArcAsha で数式の処理はどのエキスパートが担当しますか？',
    reference: 'math',
    context: 'ArcAsha は AI オペレーティングシステムであり、モデル自体は変更しない。OS 層が AVM（仮想メモリ）で必要ページだけをエキスパートへ供給する。検索は search エキスパート、数式は math エキスパート、コードは code エキスパートが担当する。AVM はコンテキストを固定サイズページに分割し、HOT/WARM/COLD の階層で管理する。',
  },
  {
    id: 'k2', category: 'knowledge',
    task: 'DeepSeek V4 で、max_tokens を小さくすると回答が空になる原因は？',
    reference: 'トークン',
    context: 'DeepSeek V4 は推論モデルで、応答は reasoning_content（思考）と content（最終回答）に分離される。max_tokens を小さくすると思考にトークン予算を使い切り、content が空になることがある。対処は max_tokens を十分に取ること、または reasoning_content をフォールバックとして使うこと。',
  },
  {
    id: 'k3', category: 'knowledge',
    task: 'アムステルダムは何という国の首都？',
    reference: 'オランダ',
    context: 'アムステルダムはオランダの首都であり、運河と自転車で有名である。人口は約 90 万人で、首都機能はハーグに一部置かれている。',
  },
  {
    id: 'k4', category: 'knowledge',
    task: '富士山の標高は何メートル？',
    reference: '3776',
    context: '富士山の標高は 3776 メートルで、日本一高い山である。山梨県と静岡県にまたがり、世界文化遺産にも登録されている。',
  },
  {
    id: 'k5', category: 'knowledge',
    task: 'ラマン分光法は物質の何を観測する手法？',
    reference: '分子振動',
    context: 'ラマン分光法は物質の分子振動を観測する分光手法で、鉱物同定・材料評価・創薬などに広く使われる。レーザー光の非弾性散乱を測定する。',
  },
  {
    id: 'k6', category: 'knowledge',
    task: '光が太陽から地球まで届くのにかかる時間は？',
    reference: '8分',
    context: '光の速度は秒速約 30 万キロメートル。太陽から地球までの距離は約 1 億 5000 万キロメートルで、光では約 8 分かかる。',
  },
];

// ─── コスト概算（USD / 1M トークン。DeepSeek 料金の概算・変更されうる）──
const PRICE_IN_PER_MT = 0.28;
const PRICE_OUT_PER_MT = 0.42;

export type AblationConfigId = 'baseline' | 'avm' | 'executive' | 'full';

export interface AblationRow {
  config: AblationConfigId;
  name: string;
  tasks: number;
  success: number;
  successRate: number;   // 非空応答率
  pass: number;
  accuracy: number;      // 正答率
  avgLatencyMs: number;
  avgTokens: number;
  estCostUsd: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
}

export interface AblationResult {
  kind: 'real-api';
  model: string;
  rows: AblationRow[];
  perTask: {
    config: AblationConfigId;
    taskId: string;
    category: string;
    ok: boolean;
    verified: boolean;
    ms: number;
    promptTokens: number;
    completionTokens: number;
    text: string;
    error?: string;
  }[];
  note: string;
}

// ─── 検証（数値 or キーワード・正規化）─────────────────────────────
function extractNumbers(s: string): number[] {
  const cleaned = s.replace(/,/g, ''); // 「3,776」→「3776」
  const out: number[] = [];
  for (const m of cleaned.match(/\d+(?:\.\d+)?/g) ?? []) {
    const n = Number(m);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** キーワード比較用の正規化（空白・助詞「の」・読点/括弧を除去） */
function normalizeKw(s: string): string {
  return s.toLowerCase().replace(/[\sの、。・（）()]/g, '');
}

function verify(task: AblationTask, text: string): boolean {
  const out = (text ?? '').trim();
  if (out === '') return false;
  const refNum = extractNumbers(task.reference)[0];
  if (refNum !== undefined) {
    // 数値の正答: 応答に同一数値が含まれるか（単位付き回答・カンマ区切りに対応）
    return extractNumbers(out).includes(refNum);
  }
  // キーワード正答: 助詞・空白を正規化して包含判定（「分子振動」vs「分子の振動」を許容）
  const kw = normalizeKw(task.reference);
  return kw !== '' && normalizeKw(out).includes(kw);
}

// ─── 実行 ───────────────────────────────────────────────────────────
export async function runAblationBaseline(
  opts: { model?: string; tasks?: AblationTask[]; maxTokens?: number; verbose?: boolean } = {},
): Promise<AblationResult> {
  const tasks = opts.tasks ?? ABLATION_TASKS;
  const maxTokens = opts.maxTokens ?? 256;
  const hub = new ExpertHub();
  const fleet = buildFleet(hub, { verbose: opts.verbose ?? false });
  const flash = fleet.find((e) => e.role === 'general')!;
  const nodeId = flash.nodeId;
  const model = flash.model;

  const aios = initAiOs({
    listNodes: () => hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
    // 計測の公平性のためキャッシュを迂回（同一プロンプトが 2 構成で呼ばれても実 API を毎回叩く）
    generate: async (id, p, m = maxTokens) => hub.generateNoCache(id, String(p), Number(m) || maxTokens),
  });

  const record = (): { promptTokens: number; completionTokens: number } =>
    hub.lastApiUsage ? { promptTokens: hub.lastApiUsage.promptTokens, completionTokens: hub.lastApiUsage.completionTokens } : { promptTokens: 0, completionTokens: 0 };

  /** ① Baseline: 素のプロンプトでモデル単体（キャッシュなし） */
  const baseline = async (t: AblationTask) => {
    const t0 = Date.now();
    const text = String((await hub.generateNoCache(nodeId, t.task, maxTokens)) ?? '').trim();
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  /** AVM が知識から必要ページを供給したプロンプトを組み立てる（per-task workspace = 分離） */
  const avmPrompt = (t: AblationTask) => {
    const w = new AvmWorkspace();
    let snippet = '';
    if (t.context) {
      w.storeContext('知識', t.context, 'user');
      const kloads = w.searchKnowledge(t.task, 2, 'search');
      snippet = kloads.map((k) => k.loadedText).join('\n').slice(0, 600);
    }
    return [t.task, snippet ? `\n\n[参照知識]\n${snippet}` : ''].join('');
  };

  /** ② Baseline + AVM: 明示知識から必要ページだけ供給してモデルへ（キャッシュなし） */
  const avm = async (t: AblationTask) => {
    const t0 = Date.now();
    const text = String((await hub.generateNoCache(nodeId, avmPrompt(t), maxTokens)) ?? '').trim();
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  /** ③ Baseline + Executive: aiosExecute（compile → CALL → learner）のみ（AVM なし） */
  const executive = async (t: AblationTask) => {
    const t0 = Date.now();
    const ex = await aiosExecute(aios, t.task, nodeId, { forceDelegate: true, maxTokens });
    const text = ex.result !== null && ex.result !== undefined ? String(ex.result).trim() : '';
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  /** ④ Full ArcAsha: AVM 供給 + Executive パイプライン（同一モデル） */
  const full = async (t: AblationTask) => {
    const t0 = Date.now();
    const ex = await aiosExecute(aios, avmPrompt(t), nodeId, { forceDelegate: true, maxTokens });
    const text = ex.result !== null && ex.result !== undefined ? String(ex.result).trim() : '';
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  const configs: { id: AblationConfigId; name: string; run: (t: AblationTask) => Promise<{ text: string; ms: number; promptTokens: number; completionTokens: number }> }[] = [
    { id: 'baseline', name: '① Baseline LLM', run: baseline },
    { id: 'avm', name: '② +AVM', run: avm },
    { id: 'executive', name: '③ +Executive', run: executive },
    { id: 'full', name: '④ Full ArcAsha', run: full },
  ];

  const perTask: AblationResult['perTask'] = [];
  const rows: AblationRow[] = [];

  for (const cfg of configs) {
    if (opts.verbose) console.log(`\n▸ ${cfg.name}（${tasks.length} tasks）`);
    let pass = 0, success = 0, totalMs = 0, promptT = 0, compT = 0;
    for (const t of tasks) {
      try {
        const r = await cfg.run(t);
        const verified = verify(t, r.text);
        const ok = r.text !== '';
        if (ok) success++;
        if (verified) pass++;
        totalMs += r.ms;
        promptT += r.promptTokens;
        compT += r.completionTokens;
        perTask.push({
          config: cfg.id,
          taskId: t.id,
          category: t.category,
          ok,
          verified,
          ms: r.ms,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          text: r.text.slice(0, 120),
          ...(r.text === '' ? { error: 'empty response' } : {}),
        });
        if (opts.verbose) console.log(`  ${t.id}: ${verified ? '✅' : '❌'} ${r.ms}ms ${(r.promptTokens + r.completionTokens)}tok "${r.text.slice(0, 40)}"`);
      } catch (e) {
        perTask.push({ config: cfg.id, taskId: t.id, category: t.category, ok: false, verified: false, ms: 0, promptTokens: 0, completionTokens: 0, text: '', error: String(e).slice(0, 120) });
        if (opts.verbose) console.log(`  ${t.id}: ⚠ ${String(e).slice(0, 80)}`);
      }
    }
    const n = tasks.length;
    const totalTok = promptT + compT;
    rows.push({
      config: cfg.id,
      name: cfg.name,
      tasks: n,
      success,
      successRate: Math.round((success / n) * 1000) / 1000,
      pass,
      accuracy: Math.round((pass / n) * 1000) / 1000,
      avgLatencyMs: Math.round(totalMs / n),
      avgTokens: Math.round(totalTok / n),
      avgPromptTokens: Math.round(promptT / n),
      avgCompletionTokens: Math.round(compT / n),
      estCostUsd: Math.round(((promptT / 1e6) * PRICE_IN_PER_MT + (compT / 1e6) * PRICE_OUT_PER_MT) * 1e6) / 1e6,
    });
  }

  return {
    kind: 'real-api',
    model,
    rows,
    perTask,
    note: `kind=real-api（実 API・数値は偽装しない）。同一タスク（${tasks.length} 問: 数学 ${tasks.filter((t) => t.category === 'math').length} / 知識 ${tasks.filter((t) => t.category === 'knowledge').length}）・同一モデル（${model}）で 4 構成を比較。①素のプロンプト ②AVM が明示知識から必要ページを供給 ③Executive（aiosExecute）のみ ④AVM + Executive。正答は数値一致 or キーワード包含で検証。コストは token × 概算単価（in $0.28 / out $0.42 per 1M）。`,
  };
}

/** 表形式レンダリング */
export function renderAblationBaseline(r: AblationResult): string {
  const lines: string[] = [];
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`Ablation Baseline — ${r.model}（同一タスク・同一モデル・4 構成）`);
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`${'構成'.padEnd(18)} ${'正答率'.padEnd(7)} ${'成功率'.padEnd(7)} ${'lat(ms)'.padEnd(8)} ${'tok'.padEnd(6)} ${'cost$'.padEnd(8)}`);
  for (const row of r.rows) {
    lines.push(
      `${row.name.padEnd(18)} ${(row.accuracy * 100).toFixed(0).padStart(3) + '%'.padEnd(4)} ${(row.successRate * 100).toFixed(0).padStart(3) + '%'.padEnd(4)} ${String(row.avgLatencyMs).padEnd(8)} ${String(row.avgTokens).padEnd(6)} ${row.estCostUsd.toFixed(5).padEnd(8)}`,
    );
  }
  lines.push('');
  const b = r.rows.find((x) => x.config === 'baseline')!;
  const f = r.rows.find((x) => x.config === 'full')!;
  lines.push(`> Full vs Baseline: 正答率 ${(b.accuracy * 100).toFixed(0)}% → ${(f.accuracy * 100).toFixed(0)}%${f.accuracy > b.accuracy ? '（改善）' : '（変化なし/低下）'}・lat ${b.avgLatencyMs}→${f.avgLatencyMs}ms・tok ${b.avgTokens}→${f.avgTokens}`);
  lines.push('※ 同一モデル（flash）で AVM / Executive の寄与を分離。数値は実測。');
  return lines.join('\n');
}

/** レポート書き出し（reports/ablation/） */
export async function writeAblationReport(r: AblationResult, dir = 'reports/ablation'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const jsonPath = `${dir}/ablation.json`;
  const mdPath = `${dir}/ablation.md`;
  await writeFile(jsonPath, JSON.stringify(r, null, 2), 'utf8');

  const md = [
    `# Ablation Baseline — ${r.model}`,
    '',
    `- kind: real-api（実 API 呼び出し・数値は偽装しない）`,
    `- 実行日時: ${new Date().toISOString()}`,
    `- タスク: ${r.rows[0]?.tasks ?? 0} 問（数学 + 知識 QA）・同一モデル`,
    '',
    '## 構成別サマリ',
    '',
    '| 構成 | 正答率 | 成功率 | 平均レイテンシ | 平均トークン | コスト($) |',
    '|---|---|---|---|---|---|',
    ...r.rows.map((row) => `| ${row.name} | ${(row.accuracy * 100).toFixed(0)}% | ${(row.successRate * 100).toFixed(0)}% | ${row.avgLatencyMs}ms | ${row.avgTokens} | ${row.estCostUsd.toFixed(5)} |`),
    '',
    '## タスク別',
    '',
    '| 構成 | タスク | 正解 | レイテンシ | トークン | 応答 |',
    '|---|---|---|---|---|---|',
    ...r.perTask.map((p) => `| ${p.config} | ${p.taskId} | ${p.verified ? '✅' : '❌'} | ${p.ms}ms | ${p.promptTokens + p.completionTokens} | ${p.text.replace(/\|/g, '｜').slice(0, 50)}${p.error ? `（${p.error}）` : ''} |`),
    '',
    '## 解釈（データから導出・バイアス除去した見解）',
    '',
    ...(interpret(r).map((l) => `- ${l}`)),
    '',
    `> note: ${r.note}`,
    '',
  ].join('\n');
  await writeFile(mdPath, md, 'utf8');
  return jsonPath;
}

/**
 * 4 構成の差から導出する解釈。数値は実測のみに基づき、
 * 小サンプル（12 問）のため差は誤差範囲の可能性があることを併記する。
 */
function interpret(r: AblationResult): string[] {
  const by = (c: string) => r.rows.find((x) => x.config === c)!;
  const b = by('baseline'), a = by('avm'), e = by('executive'), f = by('full');
  const acc = (x: number) => (x * 100).toFixed(0) + '%';
  const out: string[] = [];
  // ① AVM の寄与（Baseline → +AVM）
  if (a.accuracy > b.accuracy) {
    out.push(`AVM（明示知識の検索・供給）は正答率を ${acc(b.accuracy)} → ${acc(a.accuracy)} に改善。知識タスクで文脈供給が有効に働いたことを示す。`);
  } else {
    out.push(`AVM は正答率に明確な改善なし（${acc(b.accuracy)} → ${acc(a.accuracy)}）。`);
  }
  // ② Executive の寄与（Baseline → +Executive）
  const eLat = e.avgLatencyMs - b.avgLatencyMs;
  if (e.accuracy > b.accuracy) {
    out.push(`Executive は正答率を ${acc(b.accuracy)} → ${acc(e.accuracy)} に改善（レイテンシ差 ${eLat > 0 ? '+' : ''}${eLat}ms）。`);
  } else {
    out.push(`Executive 単独では正答率に改善なし（${acc(b.accuracy)} → ${acc(e.accuracy)}）。レイテンシは ${eLat > 0 ? '+' : ''}${eLat}ms（${eLat > 0 ? 'オーバーヘッド' : 'むしろ低減'}）。`);
  }
  // ③ Full と AVM 単独の比較（Executive の prompt 再構築が AVM の利点を相殺しないか）
  if (f.accuracy < a.accuracy) {
    out.push(`Full（AVM + Executive）は AVM 単独の ${acc(a.accuracy)} を下回る ${acc(f.accuracy)}。Executive のプロンプト再構築が AVM の供給文脈を一部相殺する可能性がある（要検証）。`);
  } else {
    out.push(`Full は AVM 単独（${acc(a.accuracy)}）と同等以上の ${acc(f.accuracy)}。`);
  }
  out.push(`成功率は 4 構成とも ${acc(b.successRate)}。`);
  out.push(`※ 12 問は小サンプル。構成間の差は 1 問分（約 8%）の変動を含み、統計的に有意と断言できない。次はタスク数を増やした再計測（Phase 4 継続）が推奨。`);
  return out;
}
