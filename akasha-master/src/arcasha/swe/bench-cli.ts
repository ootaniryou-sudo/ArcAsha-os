/**
 * SWE-bench 評価 CLI — `arcasha swe bench`.
 *
 *   npm run swe -- bench --instances <file.jsonl|json> [--instance <id>] [--limit N] [--setup-cmd "..."]
 *
 * SWE-bench instance を読み込み、各 instance を checkout → エージェントで解決 →
 * test_patch + 解決パッチ適用 → pytest で FAIL_TO_PASS / PASS_TO_PASS を評価する。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadSweBenchInstances } from './instance.js';
import { evaluateInstance, renderSweEval } from './eval.js';

interface BenchCliOpts {
  instancesFile: string;
  instanceId?: string;
  limit?: number;
  setupCmd?: string;
  maxIterations: number;
  allowRunCommand: boolean;
  verbose: boolean;
}

function parseBenchArgs(argv: string[]): BenchCliOpts {
  const opts: BenchCliOpts = { instancesFile: '', maxIterations: 30, allowRunCommand: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} に値が必要です`);
      i++;
      return v;
    };
    switch (a) {
      case '--instances': opts.instancesFile = next(); break;
      case '--instance': opts.instanceId = next(); break;
      case '--limit': {
        const n = Number(next());
        if (!Number.isSafeInteger(n) || n < 1) throw new Error('--limit は正の整数');
        opts.limit = n;
        break;
      }
      case '--setup-cmd': opts.setupCmd = next(); break;
      case '--max-iterations': {
        const n = Number(next());
        if (!Number.isSafeInteger(n) || n < 1) throw new Error('--max-iterations は正の整数');
        opts.maxIterations = n;
        break;
      }
      case '--allow-run-command': opts.allowRunCommand = true; break;
      case '--verbose': opts.verbose = true; break;
      case '-h':
      case '--help':
        console.log(BENCH_HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`未知の引数: ${a}`);
    }
  }
  if (opts.instancesFile === '') throw new Error('--instances <file> が必要です（SWE-bench instance の .jsonl / .json）');
  return opts;
}

const BENCH_HELP = `ArcAsha SWE-bench 評価（` + 'swe bench' + `）

使い方:
  npm run swe -- bench --instances <file.jsonl|json> [--instance <id>] [--limit N] [--setup-cmd "..."] [--verbose]

オプション:
  --instances <file>   SWE-bench instance ファイル（.jsonl: 1行1instance / .json: 配列）
  --instance <id>      特定の instance_id のみ評価（省略時は全件 or --limit 件）
  --limit <n>          評価する instance 数上限
  --setup-cmd "<cmd>"  リポジトリ環境セットアップ（例: "pip install -e ."）
  --max-iterations <n> エージェントの最大ツールループ回数（既定 30）
  --allow-run-command  テスト実行（pytest）とコマンド実行を許可
  --verbose            詳細ログ
`;

/** サマリを 1 行で表示する。 */
function summaryLine(instanceId: string, resolved: boolean, ms: number, calls: number): string {
  const mark = resolved ? '✅' : '❌';
  return `${mark} ${instanceId} — ${resolved ? 'RESOLVED' : 'not resolved'} (${calls} model calls / ${Math.round(ms / 1000)}s)`;
}

export async function runSweBenchCli(argv: string[]): Promise<string> {
  const opts = parseBenchArgs(argv);

  console.log(`📋 SWE-bench 評価開始 — ${opts.instancesFile}`);
  const loaded = await loadSweBenchInstances(opts.instancesFile);
  console.log(`   instance 数: ${loaded.instances.length}（スキップ: ${loaded.skipped}）`);
  if (loaded.instances.length === 0) throw new Error('評価対象の instance がありません');

  // フィルタリング
  let targets = loaded.instances;
  if (opts.instanceId) {
    targets = targets.filter((i) => i.instance_id === opts.instanceId);
    if (targets.length === 0) throw new Error(`instance_id '${opts.instanceId}' が見つかりません`);
  }
  if (opts.limit !== undefined && targets.length > opts.limit) {
    targets = targets.slice(0, opts.limit);
  }

  console.log(`   評価対象: ${targets.length} instance`);
  console.log('');

  const results = [];
  for (const inst of targets) {
    console.log(`🧪 評価: ${inst.repo}@${inst.base_commit.slice(0, 8)} (${inst.instance_id})`);
    const r = await evaluateInstance(inst, {
      maxIterations: opts.maxIterations,
      allowRunCommand: opts.allowRunCommand,
      setupCmd: opts.setupCmd,
      verbose: opts.verbose,
    });
    console.log(renderSweEval(r));
    console.log(summaryLine(inst.instance_id, r.resolved, r.totalMs, r.agentModelCalls));
    console.log('');
    results.push(r);
  }

  // 集計
  const resolvedCount = results.filter((r) => r.resolved).length;
  console.log('==================== SUMMARY ====================');
  console.log(`resolved: ${resolvedCount} / ${results.length}`);
  if (results.length > 0) {
    console.log(`resolve rate: ${((resolvedCount / results.length) * 100).toFixed(1)}%`);
  }

  // 評価結果をファイルへ保存（任意のインスタンスファイルと同ディレクトリに）
  const outPath = path.join(path.dirname(opts.instancesFile), 'swebench-results.json');
  await fs.writeFile(outPath, JSON.stringify(results.map((r) => ({
    instance_id: r.instance_id,
    resolved: r.resolved,
    modelPatch: r.modelPatch,
    failToPass: r.failToPass,
    passToPass: r.passToPass,
    agentModelCalls: r.agentModelCalls,
    agentToolCalls: r.agentToolCalls,
    totalMs: r.totalMs,
    error: r.error,
  })), null, 2), 'utf8');
  console.log(`\n結果保存: ${outPath}`);

  return `arcasha swe bench: done（resolved ${resolvedCount}/${results.length}）`;
}
