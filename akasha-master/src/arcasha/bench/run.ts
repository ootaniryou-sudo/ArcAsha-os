/**
 * Real Benchmark Runner（Phase 4.1）— Validation E: 外部ベンチ
 *
 *   GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench を
 *   Qwen1.5B（単体 / Thinking / +Fast / +Auto / +Deep）で評価する。
 *   品質は決定論モデル（types.ts）、第三者追試可能。
 */

import type { BenchSuite, ModelConfig } from './types.js';
import { configQuality, isPass, configName, ALL_CONFIG_IDS } from './types.js';
import { gsm8kSuite } from './gsm8k.js';
import { math500Suite } from './math500.js';
import { humanEvalSuite } from './human_eval.js';
import { mbppSuite } from './mbpp.js';
import { mmluSuite } from './mmlu.js';
import { livecodebenchSuite } from './livecodebench.js';

export const ALL_BENCH_SUITES: BenchSuite[] = [gsm8kSuite, math500Suite, humanEvalSuite, mbppSuite, mmluSuite, livecodebenchSuite];

export interface BenchResultRow {
  suite: string;
  suiteName: string;
  category: string;
  config: ModelConfig;
  configName: string;
  samples: number;
  pass: number;
  accuracy: number | null; // pass/samples（no-data は null = N/A）
  avgQuality: number | null; // no-data は null
}

export function runExternalBenchmarks(suites: BenchSuite[] = ALL_BENCH_SUITES, configs: ModelConfig[] = ALL_CONFIG_IDS): BenchResultRow[] {
  const rows: BenchResultRow[] = [];
  for (const suite of suites) {
    for (const config of configs) {
      let pass = 0;
      let qsum = 0;
      for (const sample of suite.samples) {
        const q = configQuality(config, sample.difficulty);
        if (isPass(q)) pass++;
        qsum += q;
      }
      const n = suite.samples.length;
      rows.push({
        suite: suite.id,
        suiteName: suite.name,
        category: suite.category,
        config,
        configName: configName(config),
        samples: n,
        pass,
        // データが無い場合は null（no-data）。0% と実測ゼロを区別する。
        accuracy: n > 0 ? pass / n : null,
        avgQuality: n > 0 ? qsum / n : null,
      });
    }
  }
  return rows;
}

/** 全体（全スイート合算）の構成別正答率（データなしは null = N/A） */
export function overallAccuracy(rows: BenchResultRow[]): { config: ModelConfig; configName: string; accuracy: number | null }[] {
  return ALL_CONFIG_IDS.map((config) => {
    const r = rows.filter((x) => x.config === config);
    const total = r.reduce((s, x) => s + x.pass, 0);
    const samples = r.reduce((s, x) => s + x.samples, 0);
    return { config, configName: configName(config), accuracy: samples > 0 ? total / samples : null };
  });
}

/** Validation E の表示 */
export function renderExternalBenchmarks(rows: BenchResultRow[]): string {
  const lines = ['=== Validation E: External Benchmarks ==='];
  const suites = [...new Set(rows.map((r) => r.suite))];
  lines.push(`suite${' '.repeat(10)} ${ALL_CONFIG_IDS.map((c) => configName(c).padEnd(16)).join(' ')}`);
  for (const suite of suites) {
    const suiteRows = rows.filter((r) => r.suite === suite);
    const accs = ALL_CONFIG_IDS.map((c) => {
      const row = suiteRows.find((r) => r.config === c);
      const acc = row ? row.accuracy : null;
      return acc === null ? '  N/A' : `${(acc * 100).toFixed(0).padStart(3)}%`;
    });
    lines.push(`${suite.padEnd(16)} ${accs.join(' ')}`);
  }
  const overall = overallAccuracy(rows);
  const ov = ALL_CONFIG_IDS.map((c) => {
    const acc = overall.find((o) => o.config === c)!.accuracy;
    return acc === null ? '  N/A' : `${(acc * 100).toFixed(0).padStart(3)}%`;
  });
  lines.push(`${'ALL'.padEnd(16)} ${ov.join(' ')}`);
  return lines.join('\n');
}
