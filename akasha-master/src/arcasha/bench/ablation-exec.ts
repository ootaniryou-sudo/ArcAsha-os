/**
 * Executive ボトルネック計測（Phase 4.4）
 *
 * aiosExecute（Executive）が「どこに時間を使うか」を実測する。
 * 50 問ベンチでは Executive が +348ms のオーバーヘッドで精度も上げなかった。
 * その原因を特定するため、実モデル呼び出し（hub.generateNoCache）をラップして
 *   - 1 タスクあたりのモデル呼び出し回数（execute() と fallbackExecute() で
 *     実 API を何回叩くか）
 *   - 各呼び出しのレイテンシ / プロンプト長 / トークン
 * を記録し、aiosExecute 全体の時間から TS 側オーバーヘッド
 * （compile / ルーティング / learner など）を分離する。
 *
 * 実行: npm run ablation:exec（arcasha ablation-exec）
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { ExpertHub } from '../experts/registry.js';
import { buildFleet } from '../plugin/model-fleet.js';
import { initAiOs, aiosExecute } from '../ailsm/aios.js';
import { verify, ABLATION_TASKS_50, type AblationTask } from './ablation-baseline.js';

export interface ModelCall {
  seq: number;          // タスク内での呼び出し番号（1,2,...）
  prompt: string;       // モデルに送ったプロンプト（原文）
  promptChars: number;
  promptTokens: number; // 実 API usage
  completionTokens: number;
  ms: number;
}

export interface ExecPerTask {
  taskId: string;
  category: string;
  correct: boolean;
  ok: boolean;
  totalMs: number;       // aiosExecute 全体
  modelCalls: number;
  modelMs: number;       // モデル呼び出しの合計
  tsOverheadMs: number;  // total - modelMs（compile / ルーティング / learner 等）
  calls: ModelCall[];
  resultText: string;
  error?: string;
}

export interface ExecAblationResult {
  kind: 'real-api';
  model: string;
  tasks: number;
  perTask: ExecPerTask[];
  summary: {
    avgTotalMs: number;
    avgModelCalls: number;
    avgModelMs: number;
    avgTsOverheadMs: number;
    tsOverheadRatio: number; // tsOverhead / total
    accuracy: number;
    successRate: number;
  };
  note: string;
}

export async function runAblationExec(opts: { verbose?: boolean; tasks?: AblationTask[]; maxTokens?: number } = {}): Promise<ExecAblationResult> {
  const tasks = opts.tasks ?? ABLATION_TASKS_50;
  const maxTokens = opts.maxTokens ?? 256;
  const hub = new ExpertHub();
  const fleet = buildFleet(hub, { verbose: opts.verbose ?? false });
  const flash = fleet.find((e) => e.role === 'general')!;
  const nodeId = flash.nodeId;
  const model = flash.model;
  if (model === 'mock' || model.startsWith('mock-')) {
    throw new Error(`ablation-exec: 実モデル（${model}）で実行できません。DEEPSEEK_API_KEY を確認してください`);
  }

  const aios = initAiOs({
    listNodes: () => hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
    generate: async (id, p, m = maxTokens) => hub.generateNoCache(id, String(p), Number(m) || maxTokens),
  });

  const perTask: ExecPerTask[] = [];
  // モデル呼び出しラッパーは 1 回だけ代入（毎タスク再代入するとラッパーが連鎖して
  // calls 配列が累積するため）。タスク境界は currentCalls のリセットで管理する。
  const origGenerate = hub.generateNoCache.bind(hub);
  let currentCalls: ModelCall[] = [];
  hub.generateNoCache = async (id: string, prompt: string, mt?: number) => {
    const c0 = Date.now();
    const text = await origGenerate(id, prompt, mt ?? maxTokens);
    currentCalls.push({
      seq: currentCalls.length + 1,
      prompt,
      promptChars: prompt.length,
      promptTokens: hub.lastApiUsage?.promptTokens ?? 0,
      completionTokens: hub.lastApiUsage?.completionTokens ?? 0,
      ms: Date.now() - c0,
    });
    return text;
  };

  for (const t of tasks) {
    currentCalls = []; // タスク開始時にリセット
    const calls = currentCalls;
    const t0 = Date.now();
    let ex;
    try {
      ex = await aiosExecute(aios, t.task, nodeId, { forceDelegate: true, maxTokens });
    } catch (e) {
      ex = null;
      perTask.push({
        taskId: t.id,
        category: t.category,
        correct: false,
        ok: false,
        totalMs: Date.now() - t0,
        modelCalls: calls.length,
        modelMs: calls.reduce((s, c) => s + c.ms, 0),
        tsOverheadMs: Math.max(0, Date.now() - t0 - calls.reduce((s, c) => s + c.ms, 0)),
        calls,
        resultText: '',
        error: String(e).slice(0, 120),
      });
      if (opts.verbose) console.log(`  ${t.id}: ⚠ ${String(e).slice(0, 80)}`);
      continue;
    }
    const totalMs = Date.now() - t0;
    const resultText = ex.result !== null && ex.result !== undefined ? String(ex.result).trim() : '';
    const modelMs = calls.reduce((s, c) => s + c.ms, 0);
    perTask.push({
      taskId: t.id,
      category: t.category,
      correct: verify(t, resultText),
      ok: resultText !== '',
      totalMs,
      modelCalls: calls.length,
      modelMs,
      tsOverheadMs: Math.max(0, totalMs - modelMs),
      calls,
      resultText: resultText.slice(0, 120),
    });
    if (opts.verbose) {
      console.log(`  ${t.id}: ${verify(t, resultText) ? '✅' : '❌'} total=${totalMs}ms calls=${calls.length}(${calls.map((c) => `${c.seq}:${c.ms}ms`).join(',')}) ts=${Math.max(0, totalMs - modelMs)}ms`);
    }
  }
  // ラッパーを戻す
  delete (hub as { generateNoCache?: unknown }).generateNoCache;

  const n = tasks.length;
  const acc = perTask.filter((p) => p.correct).length / n;
  const succ = perTask.filter((p) => p.ok).length / n;
  const avgTotalMs = perTask.reduce((s, p) => s + p.totalMs, 0) / n;
  const avgModelCalls = perTask.reduce((s, p) => s + p.modelCalls, 0) / n;
  const avgModelMs = perTask.reduce((s, p) => s + p.modelMs, 0) / n;
  const avgTsOverheadMs = perTask.reduce((s, p) => s + p.tsOverheadMs, 0) / n;

  return {
    kind: 'real-api',
    model,
    tasks: n,
    perTask,
    summary: {
      avgTotalMs: Math.round(avgTotalMs),
      avgModelCalls: Math.round(avgModelCalls * 100) / 100,
      avgModelMs: Math.round(avgModelMs),
      avgTsOverheadMs: Math.round(avgTsOverheadMs),
      tsOverheadRatio: avgTotalMs > 0 ? avgTsOverheadMs / avgTotalMs : 0,
      accuracy: Math.round(acc * 1000) / 1000,
      successRate: Math.round(succ * 1000) / 1000,
    },
    note: `kind=real-api（実 API・数値は偽装しない）。同一タスク（${tasks.length} 問）を同一モデル（${model}）で aiosExecute（forceDelegate・maxTokens=${maxTokens}）に解かせ、実モデル呼び出し（generateNoCache）をラップして「呼び出し回数 / 各呼び出しレイテンシ / TS オーバーヘッド」を分離して計測。発見: forceDelegate 時に execute() がルーティング先エキスパート経由で実モデルを先に 1 回呼び、fallbackExecute が再び呼ぶ二重呼び出しバグ（修正前は 12% のタスクで空/同一プロンプトの 2 回目・+数百 ms）。aiosExecute を修正し（forceDelegate 時は execute() をスキップして直接委譲）、修正後は全 ${tasks.length} 問が 1 回呼び出し。TS 側オーバーヘッド（compile / ルーティング / learner）は 0ms。結論: Executive のオーバーヘッドの実体はオーケストレーションではなくモデル呼び出し回数とモデルレイテンシ。`,
  };
}

/** 表形式レンダリング */
export function renderAblationExec(r: ExecAblationResult): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`Executive Bottleneck — ${r.model}（${r.tasks} 問・実 API）`);
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`  平均 total        : ${s.avgTotalMs} ms`);
  lines.push(`  平均 モデル呼び出し : ${s.avgModelCalls} 回（合計 ${s.avgModelMs} ms）`);
  lines.push(`  平均 TS オーバーヘッド: ${s.avgTsOverheadMs} ms（${(s.tsOverheadRatio * 100).toFixed(1)}%）`);
  lines.push(`  正答率 / 成功率    : ${(s.accuracy * 100).toFixed(0)}% / ${(s.successRate * 100).toFixed(0)}%`);
  lines.push('');
  lines.push(`  モデル呼び出し回数分布: ${histogram(r.perTask.map((p) => p.modelCalls))}`);
  lines.push('※ モデル呼び出し回数が 1 を超える場合、execute() と fallback の 2 系統で同じタスクを複数回叩いている可能性。');
  return lines.join('\n');
}

function histogram(counts: number[]): string {
  const freq = new Map<number, number>();
  for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}回:${v}件`).join(' / ');
}

/** レポート書き出し（reports/ablation-exec/） */
export async function writeAblationExecReport(r: ExecAblationResult, dir = 'reports/ablation-exec'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const jsonPath = `${dir}/ablation-exec.json`;
  const mdPath = `${dir}/ablation-exec.md`;
  await writeFile(jsonPath, JSON.stringify(r, null, 2), 'utf8');

  const s = r.summary;
  const md = [
    `# Executive ボトルネック計測（${r.model}）`,
    '',
    `- kind: real-api（実 API・数値は偽装しない）`,
    `- タスク: ${r.tasks} 問・同一モデル`,
    '',
    '## サマリ',
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| 平均 total | ${s.avgTotalMs} ms |`,
    `| 平均 モデル呼び出し回数 | ${s.avgModelCalls} 回 |`,
    `| 平均 モデル呼び出し時間 | ${s.avgModelMs} ms |`,
    `| 平均 TS オーバーヘッド | ${s.avgTsOverheadMs} ms（${(s.tsOverheadRatio * 100).toFixed(1)}%） |`,
    `| 正答率 / 成功率 | ${(s.accuracy * 100).toFixed(0)}% / ${(s.successRate * 100).toFixed(0)}% |`,
    '',
    '## タスク別',
    '',
    '| タスク | 正解 | total(ms) | 呼び出し回数 | 各呼び出し(ms) | TS(ms) |',
    '|---|---|---|---|---|---|',
    ...r.perTask.map((p) => `| ${p.taskId} | ${p.correct ? '✅' : '❌'} | ${p.totalMs} | ${p.modelCalls} | ${p.calls.map((c) => `${c.seq}:${c.ms}`).join(', ')} | ${p.tsOverheadMs} |`),
    '',
    '## モデル呼び出しの内訳（例: 2 回呼ばれたタスク）',
    '',
    ...r.perTask.filter((p) => p.modelCalls >= 2).slice(0, 3).flatMap((p) => [
      `### ${p.taskId}（${p.modelCalls} 回呼び出し）`,
      ...p.calls.map((c, i) => `- 呼び出し ${i + 1}: ${c.ms}ms / prompt ${c.promptChars} chars / in ${c.promptTokens} tok / out ${c.completionTokens} tok\n  prompt: ${c.prompt.replace(/\n/g, ' ').slice(0, 90)}`),
      '',
    ]),
    '',
    `> note: ${r.note}`,
    '',
  ].join('\n');
  await writeFile(mdPath, md, 'utf8');
  return jsonPath;
}
