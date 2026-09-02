/**
 * SWE-bench エージェント CLI — `arcasha swe` / `npm run swe`.
 *
 * 使い方（動作確認）:
 *   cd リポジトリ
 *   npm run swe -- --root /path/to/repo --issue "バグの説明…"
 *   npm run swe -- --root . --issue "Fix the off-by-one in compute()" --max-iterations 15
 *
 * 実行後、ツール呼び出し履歴と最終回答を出力する。
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runSweAgent } from './agent.js';

interface CliOpts {
  root: string;
  issue: string;
  maxIterations: number;
  verbose: boolean;
  extraContext?: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { root: '.', issue: '', maxIterations: 30, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} に値が必要です`);
      i++;
      return v;
    };
    switch (a) {
      case '--root': opts.root = next(); break;
      case '--issue': opts.issue = next(); break;
      case '--max-iterations': {
        const n = Number(next());
        if (!Number.isSafeInteger(n) || n < 1) throw new Error('--max-iterations は正の整数');
        opts.maxIterations = n;
        break;
      }
      case '--context': opts.extraContext = next(); break;
      case '--verbose': opts.verbose = true; break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        // 引数なしで issue を直書きする場合（便利のため）
        if (opts.issue === '' && !a.startsWith('-')) opts.issue = a;
        else throw new Error(`未知の引数: ${a}`);
    }
  }
  if (opts.issue === '') throw new Error('--issue が必要です（解決すべき問題文を指定）');
  return opts;
}

const HELP = `ArcAsha SWE Agent（SWE-bench 動作確認用）

使い方:
  npm run swe -- --root <repo> --issue "<問題文>"

オプション:
  --root <path>            作業リポジトリ（既定: 現在ディレクトリ）
  --issue "<text>"         解決すべき issue 文（必須）
  --context "<text>"       追加コンテキスト（テスト失敗出力など・任意）
  --max-iterations <n>     最大ツールループ回数（既定 30）
  --verbose                各ステップの詳細を表示
  --help                   このヘルプ
`;

/** issue 文の表示用ヘルパ。 */
function stepIcon(ok: boolean | null): string {
  if (ok === null) return '◌';
  return ok ? '✓' : '✗';
}

export async function runSweCli(argv: string[]): Promise<string> {
  const opts = parseArgs(argv);

  console.log(`🔧 ArcAsha SWE Agent — ${opts.root}`);
  console.log(`   モデル: ${process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'}`);
  console.log(`   最大ループ: ${opts.maxIterations}`);
  console.log('');

  const r = await runSweAgent({
    root: opts.root,
    issue: opts.issue,
    extraContext: opts.extraContext,
    maxIterations: opts.maxIterations,
  });

  // ステップ表示
  for (const s of r.steps) {
    console.log(`--- Step ${s.index + 1} (${s.ms}ms) ---`);
    if (s.message.toolCalls.length === 0) {
      console.log(`  final: ${(s.message.content ?? '').slice(0, 300)}`);
    } else {
      for (let k = 0; k < s.message.toolCalls.length; k++) {
        const tc = s.message.toolCalls[k];
        const tr = s.toolResults[k];
        let argsPreview = '';
        try {
          const a = JSON.parse(tc.argumentsJson) as Record<string, unknown>;
          argsPreview = Object.entries(a).map(([k2, v]) => `${k2}=${String(v).slice(0, 80)}`).join(' ');
        } catch { argsPreview = tc.argumentsJson.slice(0, 80); }
        console.log(`  ${stepIcon(tr ? tr.ok : null)} ${tc.name} ${argsPreview}`);
        if (opts.verbose && tr) {
          console.log(`      ${tr.output.split('\n').slice(0, 6).join('\n      ')}`);
        }
      }
    }
  }

  console.log('');
  console.log('==================== FINAL ANSWER ====================');
  console.log(r.finalAnswer);
  console.log('======================================================');
  console.log(`モデル呼び出し: ${r.modelCalls} 回 / ツール呼び出し: ${r.toolCalls} 回 / ${r.totalMs}ms / stop: ${r.stopReason}`);

  return 'arcasha swe: done';
}

// CLI として直接実行された場合
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runSweCli(process.argv.slice(2)).catch((e) => {
    console.error(`エラー: ${(e as Error).message}`);
    process.exit(1);
  });
}

// __dirname 参照用（実体は使わないが ESM の静粛性のため）
void dirname(fileURLToPath(import.meta.url));
