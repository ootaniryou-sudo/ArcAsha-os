/**
 * API 並列駆動ベンチ — DeepSeek を N 体の仮想ノードとして並列に駆動する
 *
 * 目的: 実機（iPad/iPhone 10〜100 台）テストを行う前に、
 *       DeepSeek-v4-flash を「同じ数の仮想 API ノード」として並列駆動し、
 *       実機テストと同じ構造（キャラバン → ハッシュ分散 → 並列 CALL）で
 *       スループット・レイテンシ・負荷分散を計測・比較検証する。
 *
 * 実機テストとの比較ポイント（kind: real-api + real-device 相当）:
 *   - ノード数 N（10 / 50 / 100 など）→ キャラバン数 ceil(N/10)
 *   - 同時並列タスク数 T（N と同じ or N×k）
 *   - ルーティング: caravanRoute（タスクキーのハッシュで配下デバイスを決定）
 *   - 計測: 全タスク完了時間・スループット（task/s）・ノード別レイテンシ分布
 *
 * すべて実 API 呼び出し（kind=real-api）。数値は偽装しない。
 */
import 'dotenv/config';
import { ExpertHub } from '../experts/registry.js';
import { initAiOs, aiosExecute } from '../ailsm/aios.js';
import type { AiOs } from '../ailsm/aios.js';

export interface ApiParallelNodeResult {
  nodeId: string;
  caravanId: string;
  ok: boolean;
  ms: number;
  text: string;
  error?: string;
}

export interface ApiParallelRound {
  nodes: number;
  caravans: number;
  tasks: number;
  totalMs: number;
  throughputPerSec: number;   // 全タスク / 秒
  avgLatencyMs: number;       // タスクあたり平均レイテンシ
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  ok: number;
  fail: number;
  perNode: ApiParallelNodeResult[];
}

export interface ApiParallelResult {
  kind: 'real-api';
  model: string;
  rounds: ApiParallelRound[];
  note: string;
}

interface ParallelOpts {
  nodeCounts: number[];        // 検証するノード数（例: [10, 50, 100]）
  tasksPerNode?: number;       // ノードあたりタスク数（デフォルト 1 = N タスク）
  maxTokens?: number;
  prompt?: string;
  /** true のとき aiosExecute（ArcAsha OS パイプライン）経由で委譲する（実機テストと同じ経路） */
  viaAiOs?: boolean;
  /** 同時実行数（デフォルト 8）。API レート制限を避けつつ実機の並列性に近づける */
  concurrency?: number;
}

const DEFAULT_PROMPT =
  '1 から 10 までの数を順に足した合計を、最後の行に「合計: X」の形式で答えてください。';

/** N 体の DeepSeek 仮想ノードを登録した Hub を組み立てる */
function buildHub(n: number, model: string, base: string, key: string): ExpertHub {
  const hub = new ExpertHub();
  for (let i = 0; i < n; i++) {
    // 実機テストと揃えるため、nodeId は「デバイス風」に api-deepseek-N を使う
    hub.addApiNode(`api-deepseek-${i}`, base, key, model);
  }
  // API ノードは実機相当のプロファイル（RTT・電力・バッテリー）を付与して
  // 実機テスト（real-device）と同じ metrics 構造で比較できるようにする
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    hub.nodeMetrics.set(`api-deepseek-${i}`, {
      batteryPct: 40 + ((i * 7) % 61), // 40-100%: 実機と同様の個体差
      rttMs: 20 + ((i * 13) % 61),     // 20-80ms: 実機の回線遅延に相当
      powerMw: 1200 + ((i * 31) % 800),// 1.2-2.0W: 実機相当（外部 API でも計測対象）
      connectedAt: now,
      lastSeenAt: now,
      source: 'sim',
    });
  }
  return hub;
}

/** ラウンドを 1 回実行: N ノード × T タスクを並列に駆動する */
async function runRound(
  hub: ExpertHub,
  nodes: string[],
  tasks: string[],
  maxTokens: number,
  prompt: string,
  viaAiOs: boolean,
  concurrency: number,
  aios?: AiOs,
): Promise<ApiParallelRound> {
  const caravans = hub.tree().caravans;
  const t0 = Date.now();

  // タスク → ノードの割り当て: キャラバン → 配下ラウンドロビン（実機と同じルート）
  const assign: { task: string; nodeId: string }[] = tasks.map((task, i) => {
    const c = caravans[i % caravans.length];
    const nodeId = c?.members[i % c.members.length]?.nodeId ?? nodes[i % nodes.length];
    return { task, nodeId };
  });

  // 同時実行数を制限して駆動（API レート制限を避ける。実機は「台数ぶん並列」に相当）
  const runOne = async ({ task, nodeId }: { task: string; nodeId: string }) => {
    const t1 = Date.now();
    try {
      let text: string;
      if (viaAiOs) {
        if (!aios) throw new Error('aios not built');
        const ex = await aiosExecute(aios, `${prompt}\n${task}`, nodeId, {
          forceDelegate: true,
          maxTokens,
        });
        text = ex.result !== null && ex.result !== undefined ? String(ex.result) : '';
      } else {
        text = await hub.generate(nodeId, `${prompt}\n${task}`, maxTokens);
      }
      return { nodeId, caravanId: hub.caravanOf(nodeId) ?? '?', ok: true, ms: Date.now() - t1, text };
    } catch (e) {
      return { nodeId, caravanId: hub.caravanOf(nodeId) ?? '?', ok: false, ms: Date.now() - t1, text: '', error: String(e).slice(0, 120) };
    }
  };

  const results = await runWithConcurrency(assign, concurrency, runOne);

  const totalMs = Date.now() - t0;
  const perNode = results.map((r, i) => {
    const base = { ...assign[i] } as { task: string; nodeId: string };
    if (r.status === 'fulfilled') {
      return { nodeId: r.value.nodeId, caravanId: r.value.caravanId, ok: r.value.ok, ms: r.value.ms, text: r.value.text } as ApiParallelNodeResult;
    }
    return { nodeId: base.nodeId, caravanId: '?', ok: false, ms: 0, text: '', error: String(r.reason).slice(0, 120) } as ApiParallelNodeResult;
  });

  const ok = perNode.filter((x) => x.ok).length;
  const fail = perNode.length - ok;
  const lats = perNode.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
  const avg = lats.length > 0 ? lats.reduce((s, v) => s + v, 0) / lats.length : 0;
  const pct = (p: number) => lats.length > 0 ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] : 0;

  return {
    nodes: nodes.length,
    caravans: caravans.length,
    tasks: tasks.length,
    totalMs,
    throughputPerSec: Math.round((tasks.length / (totalMs / 1000)) * 100) / 100,
    avgLatencyMs: Math.round(avg),
    p50Ms: pct(0.5),
    p90Ms: pct(0.9),
    p99Ms: pct(0.99),
    ok,
    fail,
    perNode,
  };
}

/**
 * 同時実行数を制限してタスクを駆動する（セマフォ）。
 * 実機は「N 体がそれぞれ独立して推論」なので、API も同時実行数を
 * concurrency に制限してレート制限を避けつつ並列性を再現する。
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<{ ok: boolean } & Record<string, unknown>>,
): Promise<PromiseSettledResult<Awaited<ReturnType<typeof fn>>>[]> {
  const out = new Array<PromiseSettledResult<Awaited<ReturnType<typeof fn>>>>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (e) {
        out[i] = { status: 'rejected', reason: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** 並列駆動ベンチ実行 */
export async function runApiParallelBench(opts?: ParallelOpts): Promise<ApiParallelResult> {
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const base = (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (!key) throw new Error('DEEPSEEK_API_KEY が設定されていません（.env を確認）');

  const nodeCounts = opts?.nodeCounts ?? [10, 50, 100];
  const tasksPerNode = opts?.tasksPerNode ?? 1;
  const maxTokens = opts?.maxTokens ?? 128;
  const prompt = opts?.prompt ?? DEFAULT_PROMPT;
  const viaAiOs = opts?.viaAiOs ?? false;
  const concurrency = opts?.concurrency ?? 8;

  const note = `kind=real-api（実 API 呼び出し・数値を偽装しない）。DeepSeek（${model}）を N 体の仮想ノードとして登録し、キャラバン（10台/組）→ 分散 → 並列 CALL（同時実行 ${concurrency}）で駆動${viaAiOs ? '（aiosExecute 経由: 実機テストと同じ ArcAsha OS パイプライン）' : ''}。実機テスト（real-device）と同じ構造で比較するための基盤。スループットは全タスク完了時間から実測。`;

  console.log(`🔄 API 並列駆動ベンチ開始（${model}）— 実 API・N体仮想ノード並列${viaAiOs ? '・aiosExecute 経由' : ''}・同時実行 ${concurrency}`);

  const rounds: ApiParallelRound[] = [];
  for (const n of nodeCounts) {
    console.log(`\n  ▸ ノード ${n} 体を登録して並列駆動 ...`);
    const hub = buildHub(n, model, base, key);
    const nodes = hub.experts.map((e) => e.nodeId);

    // viaAiOs のときは、この Hub を ModelClient として AI OS を組む（実機テストと同じ構成）
    // 共有グローバルではなく呼び出しローカルのインスタンスを runRound に渡す
    // （ベンチが重なっても nodeId→ModelClient の関連が壊れないようにする）
    let aios: AiOs | undefined;
    if (viaAiOs) {
      aios = initAiOs({
        listNodes: () => hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
        generate: async (nodeId, p, m = maxTokens) => hub.generate(nodeId, String(p), Number(m) || maxTokens),
      });
    }

    const tasks = Array.from({ length: n * tasksPerNode }, (_, i) => `タスク${i + 1}: 数字 ${i + 1} を 2 倍にしてください`);
    const round = await runRound(hub, nodes, tasks, maxTokens, prompt, viaAiOs, concurrency, aios);
    rounds.push(round);
    console.log(`     ✅ 完了: ${round.ok}/${round.tasks} 成功・${round.totalMs}ms・${round.throughputPerSec} task/s（キャラバン ${round.caravans}）`);
  }

  return { kind: 'real-api', model, rounds, note };
}

/** 表形式レンダリング（CLI / モニター用） */
export function renderApiParallel(r: ApiParallelResult): string {
  const lines: string[] = [];
  lines.push('══════════════════════════════════════════════════════');
  lines.push(`API 並列駆動 — ${r.model}（N体仮想ノード・実機テスト比較用）`);
  lines.push('══════════════════════════════════════════════════════');
  lines.push(`note : ${r.note}`);
  lines.push('');
  lines.push(`${'nodes'.padEnd(7)} ${'caravans'.padEnd(9)} ${'tasks'.padEnd(6)} ${'total(ms)'.padEnd(10)} ${'thr(t/s)'.padEnd(9)} ${'avg(ms)'.padEnd(8)} ${'p50'.padEnd(6)} ${'p90'.padEnd(6)} ${'ok/fail'.padEnd(8)}`);
  for (const rnd of r.rounds) {
    lines.push(
      `${String(rnd.nodes).padEnd(7)} ${String(rnd.caravans).padEnd(9)} ${String(rnd.tasks).padEnd(6)} ${String(rnd.totalMs).padEnd(10)} ${String(rnd.throughputPerSec).padEnd(9)} ${String(rnd.avgLatencyMs).padEnd(8)} ${String(rnd.p50Ms).padEnd(6)} ${String(rnd.p90Ms).padEnd(6)} ${`${rnd.ok}/${rnd.fail}`.padEnd(8)}`,
    );
  }
  // スケーリング考察（実機テストとの比較用）
  if (r.rounds.length >= 2) {
    const a = r.rounds[0];
    const b = r.rounds[r.rounds.length - 1];
    const nodeGain = b.nodes / a.nodes;
    const thrGain = b.throughputPerSec / Math.max(0.0001, a.throughputPerSec);
    lines.push('');
    lines.push(`> スケーリング: ノード ${a.nodes} → ${b.nodes}（${nodeGain.toFixed(1)}x）でスループット ${a.throughputPerSec.toFixed(1)} → ${b.throughputPerSec.toFixed(1)} task/s（${thrGain.toFixed(2)}x）`);
    lines.push(`> 実機テストでは同じ N 体（iPad/iPhone）でこのスループットと比較する。`);
  }
  lines.push('※ kind=real-api（実測）。外部 API の並列限界はレート制限・接続数で変わりうる。');
  return lines.join('\n');
}
