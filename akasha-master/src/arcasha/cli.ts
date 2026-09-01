#!/usr/bin/env node
/**
 * ArcAsha CLI（v1.0）— `arcasha` コマンド
 *
 *   npm install arcasha → `arcasha benchmark` が動く（package.json の bin）。
 *   - benchmark : Real Benchmark Suite（Simulation）+ Decision Explanation + Real Device + reports/ 生成
 *   - apibench  : API 比較（DeepSeek 単体 vs DeepSeek + ArcAsha、同一モデル・同一問題・実測）
 *   - apiparallel : DeepSeek を N 体の仮想ノードとして並列駆動（実機テスト比較用）
 *   - apiparallel-aios : 同上を aiosExecute（ArcAsha OS パイプライン）経由で駆動
 *   - policy    : OS ポリシー学習デモ（Decision Explanation を学習データにする）
 *   - hierarchy : Hierarchy Runtime デモ（Master → Caravan → Device → Expert が考える→判断→命令→学習）
 *   - cognitive : Cognitive Graph Runtime デモ（タスクごとに知能の配線を動的生成・共有メモリ + IR 通信・Team Learning・Knowledge Oasis）
 *   - version   : version 表示
 *   - help      : ヘルプ
 */

export const ARCASHA_VERSION = '1.0.0';

export async function runCli(argv: string[]): Promise<string> {
  const cmd = argv[0] ?? 'help';
  switch (cmd) {
    case 'benchmark': {
      const { main } = await import('./bench/cli.js');
      await main(argv[1]);
      return `arcasha benchmark: done（reports/benchmark/ に kind=simulation の report.json/csv/md を生成）`;
    }
    case 'apibench': {
      const { runApiBenchCli } = await import('./bench/api-bench-cli.js');
      return await runApiBenchCli();
    }
    case 'apiparallel': {
      // 例: arcasha apiparallel 10 50 100  (ノード数をスペース区切り)
      const { runApiParallelBench, renderApiParallel } = await import('./bench/api-parallel.js');
      const counts = argv.slice(1).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
      const r = await runApiParallelBench({ nodeCounts: counts.length > 0 ? counts : [10, 50, 100] });
      const text = renderApiParallel(r);
      console.log(text);
      return 'arcasha apiparallel: done（kind=real-api・N体仮想ノード並列）';
    }
    case 'apiparallel-aios': {
      // aiosExecute（ArcAsha OS パイプライン）経由で並列駆動（実機テストと同じ経路）
      const { runApiParallelBench, renderApiParallel } = await import('./bench/api-parallel.js');
      const counts = argv.slice(1).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
      const r = await runApiParallelBench({ nodeCounts: counts.length > 0 ? counts : [10, 50, 100], viaAiOs: true });
      const text = renderApiParallel(r);
      console.log(text);
      return 'arcasha apiparallel-aios: done（kind=real-api・aiosExecute 経由並列）';
    }
    case 'ablation-exec': {
      // Phase 4.4: Executive（aiosExecute）のボトルネック計測（モデル呼び出し回数 / TS オーバーヘッドの分離）
      const { runAblationExec, renderAblationExec, writeAblationExecReport } = await import('./bench/ablation-exec.js');
      const r = await runAblationExec({ verbose: argv[1] === 'verbose' });
      console.log(renderAblationExec(r));
      const jsonPath = await writeAblationExecReport(r);
      const anyOk = r.perTask.some((p) => p.ok);
      if (!anyOk) {
        throw new Error(`ablation-exec: 全タスクが API エラー／空応答でした（report: ${jsonPath}）`);
      }
      return `arcasha ablation-exec: done（kind=real-api・Executive ボトルネック計測・report: ${jsonPath}）`;
    }
    case 'ablation-long': {
      // Phase 4.2: 長文コンテキストでの AVM 効果（全文供給 vs 関連ページのみ供給）を実測
      const { runAblationLong, renderAblationLong, writeAblationLongReport } = await import('./bench/ablation-long.js');
      const r = await runAblationLong({ verbose: argv[1] === 'verbose' });
      console.log(renderAblationLong(r));
      const jsonPath = await writeAblationLongReport(r);
      // API 成功は p.error / p.text で判定する（0% 正答は正当なベンチ結果なので correct では判定しない）
      const anyOk = r.perTask.some((p) => !p.error && p.text !== '');
      if (!anyOk) {
        throw new Error(`ablation-long: 全タスクが API エラー／空応答でした。API キー・接続を確認してください（report: ${jsonPath}）`);
      }
      return `arcasha ablation-long: done（kind=real-api・長文 AVM 効果・report: ${jsonPath}）`;
    }
    case 'ablation': {
      // Phase 4: 同一タスク・同一モデルで 4 構成（Baseline/+AVM/+Executive/Full）を比較 + McNemar 検定
      //   arcasha ablation           → 50 問 × 1 回（標準）
      //   arcasha ablation quick     → 12 問 × 1 回（スモーク）
      //   arcasha ablation verbose N → 50 問 × N 回（詳細ログ + 統計検定）
      const mode = argv[1]; // 'quick' | 'verbose' | undefined
      const runsRaw = argv[2] === undefined ? 1 : Number(argv[2]);
      if (!Number.isSafeInteger(runsRaw) || runsRaw < 1) {
        throw new Error(`arcasha ablation: runs は正の安全な整数（1 以上）を指定してください（指定値: ${argv[2]}）`);
      }
      const runs = runsRaw;
      const { runAblationBaseline, renderAblationBaseline, writeAblationReport, ABLATION_TASKS, ABLATION_TASKS_50 } = await import('./bench/ablation-baseline.js');
      const tasks = mode === 'quick' ? ABLATION_TASKS : ABLATION_TASKS_50;
      const r = await runAblationBaseline({ tasks, verbose: mode === 'verbose', runs });
      console.log(renderAblationBaseline(r));
      // quick（12 問スモーク）は権威レポート（ablation.*）を上書きしないよう別名で書き出す
      const jsonPath = await writeAblationReport(r, 'reports/ablation', mode === 'quick' ? 'ablation-quick' : 'ablation');
      // 全タスクが失敗した場合（API 全滅など）は実測として成立しないため失敗扱いにする
      const anyOk = r.perTask.some((p) => p.ok > 0);
      if (!anyOk) {
        throw new Error(`ablation: 全タスクが失敗しました（success=0）。API キー・接続を確認してください（report: ${jsonPath}）`);
      }
      return `arcasha ablation: done（kind=real-api・${tasks.length}問×${runs}回・4 構成比較・report: ${jsonPath}）`;
    }
    case 'metaos50': {
      // 例: arcasha metaos50 50 50  (ノード数 同時実行数)
      // DeepSeek API を N 体の仮想ノードとして登録し、フル Meta OS（aiosExecute）を
      // 経由して N 並列で駆動し、完走性・正しさ・OS 学習・キャラバンルーティングを検証する。
      const { runMetaOs50, renderMetaOs50, writeMetaOs50Report } = await import('./bench/metaos-50.js');
      // 引数は正の安全な整数のみ受理（1.5 などの小数・非数を拒否して既定値へ）
      const toInt = (v: string | undefined, def: number): number => {
        if (v === undefined) return def;
        const n = Number(v);
        return Number.isSafeInteger(n) && n > 0 ? n : def;
      };
      const n = toInt(argv[1], 50);
      const c = toInt(argv[2], n);
      const r = await runMetaOs50({ nodes: n, concurrency: c });
      console.log(renderMetaOs50(r));
      const jsonPath = await writeMetaOs50Report(r);
      // V1..V6 に FAIL があれば非ゼロ終了で失敗を通知（自動化が検出できるように）
      const failed = Object.values(r.verifications).some((v) => !v);
      if (failed) throw new Error(`metaos50: 検証が FAIL（V1..V6 のいずれか）。詳細: ${jsonPath}`);
      return `arcasha metaos50: done（kind=real-api・${r.nodes}体同時駆動・検証 V1..V6 全 PASS・report: ${jsonPath}）`;
    }
    case 'policy': {
      const { runPolicyLearningDemo } = await import('./attachments/decision-log.js');
      return runPolicyLearningDemo();
    }
    case 'replay': {
      const { captureReplay, renderReplay, runReplayDemo } = await import('./attachments/replay.js');
      if (argv[1]) {
        const booted = (await import('./ailsm/expert-runtime.js')).boot();
        const t = await captureReplay(argv[1], booted, { mode: 'auto', budgetMs: 1000 });
        return renderReplay(t);
      }
      return runReplayDemo();
    }
    case 'hierarchy': {
      const { runHierarchyDemoCli } = await import('./hierarchy/hierarchy-runtime.js');
      await runHierarchyDemoCli();
      return 'arcasha hierarchy: done';
    }
    case 'cognitive': {
      const { runCognitiveDemo } = await import('./cognitive/demo.js');
      console.log(await runCognitiveDemo());
      return 'arcasha cognitive: done';
    }
    case 'version':
      return `ArcAsha v${ARCASHA_VERSION}`;
    case 'help':
    default:
      return [
        `ArcAsha v${ARCASHA_VERSION} — AI Operating System for Modular Reasoning and Runtime Intelligence`,
        '',
        'Usage: arcasha <command>',
        '  benchmark   Real Benchmark Suite（Simulation）+ Decision Explanation + Real Device + reports/ 生成',
        '  replay      Decision Replay（なぜこの回答になったのかをステップ再生。引数でタスク指定可）',
        '  apiparallel     DeepSeek を N 体の仮想ノードとして並列駆動（実機テスト比較用）',
        '  apiparallel-aios 同上を aiosExecute（ArcAsha OS パイプライン）経由で駆動',
        '  metaos50        DeepSeek × N 体（既定 50）を N 並列で Meta OS 経由駆動し V1..V6 を検証（reports/metaos50/）',
        '  ablation        Phase 4: 50 問（quick で 12 問）・同一モデルで Baseline / +AVM / +Executive / Full を比較し McNemar 検定（reports/ablation/）',
        '  ablation-long   Phase 4.2: 長文コンテキストで AVM の効果（全文供給 vs 関連ページのみ供給）を実測（reports/ablation-long/）',
        '  ablation-exec   Phase 4.4: Executive（aiosExecute）のボトルネック計測（モデル呼び出し回数 / TS オーバーヘッドを分離・reports/ablation-exec/）',
        '  policy      OS ポリシー学習デモ（Decision Explanation を学習データにして Meta Executive のポリシーを更新）',
        '  hierarchy   Hierarchy Runtime デモ（Master → Caravan → Device → Expert の階層が自律判断）',
        '  cognitive   Cognitive Graph Runtime デモ（タスクごとに知能の配線を動的生成 → 共有メモリ + IR 通信 → Team Learning → Knowledge Oasis）',
        '  version     version 表示',
        '  help        このヘルプ',
      ].join('\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((s) => console.log(s))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
