/**
 * Caravan Ablation Benchmark（PR 5）— 構成（memory / recovery / formation）の比較
 *
 * runCaravanE2E の構成フラグを ON/OFF した構成を同一タスク群で実行し、
 * Success Rate / Attempts / Latency / Token / Cost / Verification Pass Rate /
 * Recovery Success Rate / Expert Utilization を集計する。
 *
 * 構成:
 *   base             : 何も有効化しない（Ablation の対照）
 *   memory           : Oasis Retrieval → INJECT のみ
 *   recovery         : 検証失敗 → 戦略選択（DECISIONS 記録）のみ
 *   memory-recovery  : memory + recovery
 *   full             : memory + recovery + formation（不足能力 → Expert 追加）
 *
 * 研究姿勢: 決定論 Simulation で「構成ごとの成功可否・メトリクス差」を比較できることを
 * 証明する。性能改善の主張はしない（model 差し替えで実モデル比較も可能）。
 */
import { runCaravanE2E, type CaravanE2EResult, type ModelExecutor } from './caravan-e2e.js';
import type { CaravanNotebook, NotebookExpert } from './notebook.js';
import type { CaravanDomain, CaravanVerificationResult } from './caravan-verifier.js';
import type { PoolExpert } from './pool.js';

export type AblationConfig = 'base' | 'memory' | 'recovery' | 'memory-recovery' | 'full';

export interface AblationConfigSpec {
  id: AblationConfig;
  memory: boolean;
  recovery: boolean;
  formation: boolean;
}

/** Ablation の構成一覧（Base / Memory / Recovery / Memory+Recovery / Full） */
export const ABLATION_CONFIGS: readonly AblationConfigSpec[] = [
  { id: 'base', memory: false, recovery: false, formation: false },
  { id: 'memory', memory: true, recovery: false, formation: false },
  { id: 'recovery', memory: false, recovery: true, formation: false },
  { id: 'memory-recovery', memory: true, recovery: true, formation: false },
  { id: 'full', memory: true, recovery: true, formation: true },
];

/** ベンチに含めるタスク（team 未指定なら composeTeam で自動編成） */
export interface AblationTask {
  task: string;
  domain?: CaravanDomain;
  team?: readonly NotebookExpert[];
  verifier?: (nb: CaravanNotebook) => CaravanVerificationResult;
}

/** 1 構成の集計結果 */
export interface AblationRow {
  config: AblationConfig;
  /** タスク成功率（success / tasks） */
  successRate: number;
  avgAttempts: number;
  avgLatencyMs: number;
  avgTokens: number;
  avgCost: number;
  /** VERIFY 試行全体に対する PASS 率（中間試行も含む） */
  verificationPassRate: number;
  /** recovery を使ったタスクのうち成功した割合 */
  recoverySuccessRate: number;
  /** 使用したユニーク Expert 数 / pool サイズ */
  expertUtilization: number;
}

export interface CaravanAblationOptions {
  pool: readonly PoolExpert[];
  tasks: readonly AblationTask[];
  /** 実モデル接続口（任意。未指定なら決定論 Simulation） */
  model?: ModelExecutor;
  maxAttempts?: number;
}

export interface CaravanAblationResult {
  configs: AblationRow[];
  totalTasks: number;
  /** 構成 × タスクの生結果（デバッグ / 追試用） */
  byConfig: Record<AblationConfig, CaravanE2EResult[]>;
}

function average(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function aggregate(config: AblationConfig, results: readonly CaravanE2EResult[], poolSize: number): AblationRow {
  const n = results.length;
  const success = results.filter((r) => r.success).length;
  const recoveryUsed = results.filter((r) => r.recoveryUsed);
  const recoverySuccess = recoveryUsed.filter((r) => r.success).length;
  const verifyRows = results.flatMap((r) => r.rounds).filter((row) => row.phase === 'VERIFY');
  const verifyPass = verifyRows.filter((row) => row.note.startsWith('PASS')).length;
  const uniqueExperts = new Set(results.flatMap((r) => r.team));

  return {
    config,
    successRate: n === 0 ? 0 : success / n,
    avgAttempts: average(results.map((r) => r.attempts)),
    avgLatencyMs: average(results.map((r) => r.latencyMs)),
    avgTokens: average(results.map((r) => r.tokens)),
    avgCost: average(results.map((r) => r.cost)),
    verificationPassRate: verifyRows.length === 0 ? 0 : verifyPass / verifyRows.length,
    recoverySuccessRate: recoveryUsed.length === 0 ? 0 : recoverySuccess / recoveryUsed.length,
    expertUtilization: poolSize === 0 ? 0 : uniqueExperts.size / poolSize,
  };
}

/**
 * 全構成 × 全タスクで Caravan Cognitive E2E を実行し、構成ごとに集計する。
 * 決定論 Simulation（model 未指定）では同一入力 → 同一結果（追試可能）。
 */
export async function runCaravanAblation(opts: CaravanAblationOptions): Promise<CaravanAblationResult> {
  if (!opts.pool || opts.pool.length === 0) {
    throw new Error('CaravanAblation: pool が未指定');
  }
  const byConfig = {
    base: [] as CaravanE2EResult[],
    memory: [] as CaravanE2EResult[],
    recovery: [] as CaravanE2EResult[],
    'memory-recovery': [] as CaravanE2EResult[],
    full: [] as CaravanE2EResult[],
  };
  for (const spec of ABLATION_CONFIGS) {
    for (const t of opts.tasks) {
      const r = await runCaravanE2E({
        task: t.task,
        pool: opts.pool,
        team: t.team,
        domain: t.domain,
        verifier: t.verifier,
        memory: spec.memory,
        recovery: spec.recovery,
        formation: spec.formation,
        maxAttempts: opts.maxAttempts,
        model: opts.model,
      });
      byConfig[spec.id].push(r);
    }
  }
  const configs = ABLATION_CONFIGS.map((spec) => aggregate(spec.id, byConfig[spec.id], opts.pool.length));
  return { configs, totalTasks: opts.tasks.length, byConfig };
}

/** 集計結果のテーブル表示（デモ / CLI 用） */
export function renderCaravanAblation(r: CaravanAblationResult): string {
  const lines: string[] = [];
  lines.push(`Caravan Ablation（tasks=${r.totalTasks}）`);
  lines.push(
    'config           | success | attempts | latency | tokens | cost      | verifyPass | recoverySuccess | utilization',
  );
  for (const c of r.configs) {
    lines.push(
      `${c.config.padEnd(16)} | ${(c.successRate * 100).toFixed(0).padStart(3)}%   | ${c.avgAttempts.toFixed(1).padStart(3)}     | ${c.avgLatencyMs.toFixed(0).padStart(4)}ms | ${c.avgTokens.toFixed(0).padStart(5)} | $${c.avgCost.toFixed(5).padStart(7)} | ${(c.verificationPassRate * 100).toFixed(0).padStart(3)}%       | ${(c.recoverySuccessRate * 100).toFixed(0).padStart(3)}%            | ${(c.expertUtilization * 100).toFixed(0).padStart(3)}%`,
    );
  }
  return lines.join('\n');
}
