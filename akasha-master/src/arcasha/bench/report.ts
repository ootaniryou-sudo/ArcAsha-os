/**
 * Report Generator（Phase 4.1）— report.json / report.csv / report.md を自動生成
 *
 *   第三者追試のための機械可読出力（決定論・バージョン付き）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchResultRow } from './run.js';
import { overallAccuracy } from './run.js';
import type { OverheadProfile } from './overhead.js';
import type { CaravanBenchRow } from './caravan.js';
import type { OasisBenchResult } from './oasis.js';

export const REPORT_VERSION = '1.3.0';
export const REPORT_CORPUS = 'GSM8K/MATH500/HumanEval/MBPP/MMLU/LiveCodeBench (deterministic subset)';

export const VALIDATION_KIND = 'simulation';
export const VALIDATION_NOTE = '設計上の評価モデル（決定論・再現可能）。実機実測は Real Device Benchmark（bench/real-device.ts）と区別する。';

/** JSON レポート（機械可読・追試可能） */
export function buildJsonReport(rows: BenchResultRow[], overhead: OverheadProfile[], caravan?: CaravanBenchRow[], oasis?: OasisBenchResult): string {
  return JSON.stringify(
    {
      version: REPORT_VERSION,
      kind: VALIDATION_KIND,
      note: VALIDATION_NOTE,
      corpus: REPORT_CORPUS,
      configs: [...new Set(rows.map((r) => r.configName))],
      overall: overallAccuracy(rows),
      results: rows,
      osOverhead: overhead,
      caravanScaling: caravan ?? [],
      oasisLearning: oasis ?? null,
    },
    null,
    2,
  );
}

/** CSV セルをエスケープ（カンマ・引用符・改行を含む値の安全化） */
function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV レポート（表計算ソフト対応） */
export function buildCsvReport(rows: BenchResultRow[]): string {
  const header = 'suite,suite_name,category,config,config_name,samples,pass,accuracy,avg_quality';
  const lines = [header];
  for (const r of rows) {
    const vals = [r.suite, r.suiteName, r.category, r.config, r.configName, r.samples, r.pass, r.accuracy === null ? 'N/A' : r.accuracy.toFixed(4), r.avgQuality === null ? 'N/A' : r.avgQuality.toFixed(4)].map((v) => csvEscape(String(v)));
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

/** Markdown レポート（論文化用） */
export function buildMarkdownReport(rows: BenchResultRow[], overhead: OverheadProfile[], caravan?: CaravanBenchRow[], oasis?: OasisBenchResult): string {
  const lines: string[] = [];
  lines.push(`# ArcAsha Benchmark Report`);
  lines.push('');
  lines.push(`- version: ${REPORT_VERSION}`);
  lines.push(`- kind: ${VALIDATION_KIND}（${VALIDATION_NOTE}）`);
  lines.push(`- corpus: ${REPORT_CORPUS}`);
  lines.push('');
  lines.push(`## External Benchmarks (Validation E)`);
  lines.push('');
  lines.push(`| Suite | ${[...new Set(rows.map((r) => r.configName))].join(' | ')} |`);
  lines.push(`|-------|${[...new Set(rows.map((r) => r.configName))].map(() => '------|').join('')}`);
  for (const suite of [...new Set(rows.map((r) => r.suite))]) {
    const cells = [...new Set(rows.map((r) => r.configName))].map((cn) => {
      const row = rows.find((r) => r.suite === suite && r.configName === cn);
      const acc = row ? row.accuracy : null;
      return acc === null ? 'N/A' : `${(acc * 100).toFixed(0)}%`;
    });
    lines.push(`| ${suite} | ${cells.join(' | ')} |`);
  }
  const overall = overallAccuracy(rows);
  lines.push(`| **ALL** | ${overall.map((o) => `${o.accuracy === null ? 'N/A' : (o.accuracy * 100).toFixed(0)}%`).join(' | ')} |`);
  lines.push('');
  lines.push(`## OS Overhead`);
  lines.push('');
  for (const p of overhead) {
    const name = p.components.length === 1 ? p.components[0].component : 'OS layered';
    const cpu = p.components.reduce((s, c) => s + c.cpuPct, 0);
    const llm = p.components.filter((c) => c.component.includes('LLM')).reduce((s, c) => s + c.cpuPct, 0);
    lines.push(`- **${p.config}**: ${name}（CPU ${cpu}%、うち LLM ${llm}%）`);
  }
  if (caravan && caravan.length > 0) {
    lines.push('');
    lines.push(`## Caravan スケーラビリティ (Validation F)`);
    lines.push('');
    lines.push(`| デバイス数 | キャラバン数 | Master管理対象(Flat) | Master管理対象(Caravan) | 削減 | 探索(Flat) | 探索(Caravan) | ホップ |`);
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of caravan) {
      lines.push(`| ${r.devices} | ${r.caravans} | ${r.flatManaged} | ${r.caravanManaged} | ${r.reductionX}x | ${r.flatSearch} | ${r.caravanSearch} | ${r.hopsFlat}→${r.hopsCaravan} |`);
    }
    lines.push('');
    const last = caravan[caravan.length - 1];
    lines.push(`> Master は ${last.devices.toLocaleString()} 台でも ${last.caravans} キャラバンを管理するだけ（フラットの ${last.reductionX}x 削減）。`);
  }
  if (oasis) {
    lines.push('');
    lines.push(`## Lesson Memory / Team Learning の効果 (Validation G)`);
    lines.push('');
    lines.push(`| フェーズ | 成功率(Naive) | 成功率(Learned) | 平均遅延(Naive) | 平均遅延(Learned) |`);
    lines.push('|---|---:|---:|---:|---:|');
    for (let i = 0; i < oasis.naive.length; i++) {
      const n = oasis.naive[i];
      const l = oasis.learned[i];
      lines.push(`| ${n.phase} | ${(n.successRate * 100).toFixed(0)}% | ${(l.successRate * 100).toFixed(0)}% | ${n.avgLatencyMs.toFixed(0)}ms | ${l.avgLatencyMs.toFixed(0)}ms |`);
    }
    const f = oasis.final;
    lines.push('');
    lines.push(`> 成功率 ${(f.naive.successRate * 100).toFixed(0)}% → ${(f.learned.successRate * 100).toFixed(0)}%（+${(f.improvement.successRate * 100).toFixed(0)}pt）/ 遅延 ${f.naive.avgLatencyMs.toFixed(0)}ms → ${f.learned.avgLatencyMs.toFixed(0)}ms`);
    lines.push('> モデルの重みを変えずに、OS の運用知識（Team / Policy / Lesson）だけで改善することを実証。');
  }
  return lines.join('\n');
}

/** レポートをディスクへ書き出す（既定: reports/benchmark/） */
export async function writeReports(dir: string, rows: BenchResultRow[], overhead: OverheadProfile[], caravan?: CaravanBenchRow[], oasis?: OasisBenchResult): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const json = buildJsonReport(rows, overhead, caravan, oasis);
  const csv = buildCsvReport(rows);
  const md = buildMarkdownReport(rows, overhead, caravan, oasis);
  const targets: [string, string][] = [
    [join(dir, 'report.json'), json],
    [join(dir, 'report.csv'), csv],
    [join(dir, 'report.md'), md],
  ];
  for (const [path, content] of targets) {
    await writeFile(path, content, 'utf8');
    files.push(path);
  }
  return files;
}
