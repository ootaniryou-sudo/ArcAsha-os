/**
 * Caravan Loop（Phase A）— PLAN → EXECUTE → OBSERVE → VERIFY → REPLAN の閉ループ
 *
 * CaravanNotebook を Single Source of Truth とし、全状態遷移を Notebook 経由で行う。
 * Notebook 外にタスク状態を持つ新規実装を作らない。
 *
 *   1. PLAN     : planning が Notebook に plan（IR）を書く
 *   2. EXECUTE  : 各 Expert が readSections を読み、成果物（IR）を writeSections に書く
 *   3. OBSERVE  : Notebook の現在状態が観測そのもの（共有メモリ不要）
 *   4. VERIFY   : 成果物を検証（回答の良さではなく成果物の検査）
 *   5. PASS     : FINAL_DIAGNOSIS を書いて終了
 *      FAIL     : ERRORS を書いて REPLAN（次の Round で再計画・再実行）
 *
 * 予算（Budget）:
 *   - maxRounds        : 最大 Round 数（超過で stopReason='max-rounds'）
 *   - thinkingBudgetMs : 全体の思考予算（超過で 'budget-exhausted'）
 *   - expertBudgetMs   : Expert ごとの予算（超過で 'budget-exhausted'）
 *
 * Phase C（Dynamic Expert Formation）への接続口:
 *   runCaravan は team（NotebookExpert[]）を受け取る。Phase C ではここを
 *   composeTeam / Oasis 推奨で動的に編成する（本実装は固定 Caravan + 固定 Expert）。
 */
import { CaravanNotebook } from './notebook.js';
import type { NotebookEntry, NotebookExpert, NotebookSection } from './notebook.js';
import { detectCaravanDomain, verifyCaravanArtifact, type CaravanDomain, type CaravanVerificationResult } from './caravan-verifier.js';
import type { KnowledgeOasis } from './oasis.js';
import { makeLesson } from './oasis.js';
import type { TeamLearner } from './team-learning.js';
import type { PoolExpert } from './pool.js';
import { formationExpertFromPool, type ExpertFormationPolicy, type FormationContext } from './expert-formation.js';

/** ループの実行段階 */
export type CaravanPhase = 'PLAN' | 'EXECUTE' | 'OBSERVE' | 'VERIFY' | 'REPLAN' | 'DIAGNOSIS';

/** 1 ラウンドの実行ログ */
export interface CaravanRoundLog {
  round: number;
  phase: CaravanPhase;
  note: string;
  spentMs: number;
}

/** Caravan 実行の予算 */
export interface CaravanBudget {
  /** 最大 Round 数 */
  maxRounds: number;
  /** 全体の思考予算（ms） */
  thinkingBudgetMs: number;
  /** Expert ごとの予算（ms） */
  expertBudgetMs: number;
}

export const DEFAULT_CARAVAN_BUDGET: CaravanBudget = {
  maxRounds: 3,
  thinkingBudgetMs: 5_000,
  expertBudgetMs: 2_000,
};

export interface CaravanRunOptions {
  task: string;
  /** 固定 Caravan（Phase A+B）。Phase C では composeTeam / Oasis 推奨で動的編成する。 */
  team: NotebookExpert[];
  budget?: Partial<CaravanBudget>;
  /** 成果物検証。既定: verifyCaravanArtifact(nb, detectCaravanDomain(task)) */
  verifier?: (nb: CaravanNotebook) => CaravanVerificationResult;
  /** 完了後に Oasis へ完成 Notebook snapshot を保存（任意） */
  oasis?: KnowledgeOasis;
  /** 完了後に Team Learning へ記録（任意） */
  learner?: TeamLearner;
  /** Dynamic Expert Formation（任意）。VERIFY 失敗時に不足能力を推定して Expert を追加し、再実行する */
  formation?: ExpertFormationPolicy;
  /** AI Pool（formation 使用時に必要） */
  pool?: readonly PoolExpert[];
  /** 編成で追加できる Expert の最大数（既定 1） */
  maxFormation?: number;
}

export interface CaravanRunResult {
  task: string;
  team: NotebookExpert[];
  teamKey: string;
  notebook: CaravanNotebook;
  rounds: CaravanRoundLog[];
  totalMs: number;
  success: boolean;
  stopReason: 'verified' | 'max-rounds' | 'budget-exhausted';
  spentMs: number;
  remainingBudgetMs: number;
  verification: CaravanVerificationResult;
  finalSnapshot: ReturnType<CaravanNotebook['snapshot']>;
  finalDiagnosis?: NotebookEntry;
}

/** IR 値からキーを抽出（例: "program: [...]" → "program"） */
function irKey(ir: string): string {
  const m = /^([a-z][a-z0-9_-]*)\s*:/.exec(ir);
  return m ? m[1] : 'note';
}

/** タイムアウト付き promise。未解決の Expert 実行を強制終了させる。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${what} がタイムアウト（${ms}ms）`));
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 1 Expert を実行し、結果 IR を writeSections[0] に書く。
 * execute の例外・タイムアウトは Loop を中断せず、実行失敗（ok=false）として返す
 * （呼び出し側が notebook.fail() + REPLAN へ変換する）。
 */
async function runExpert(
  notebook: CaravanNotebook,
  expert: NotebookExpert,
  round: number,
  timeoutMs: number,
): Promise<{ ms: number; ir: string; ok: boolean }> {
  const view = notebook.view(expert);
  let r: { ms: number; ir: string; ok: boolean };
  try {
    r = await withTimeout(
      expert.execute!({ task: notebook.task, round, view }),
      Math.max(100, timeoutMs),
      `expert ${expert.id}`,
    );
  } catch (e) {
    return { ms: 0, ir: `error: ${(e as Error).message.slice(0, 60)}`, ok: false };
  }
  if (r.ok) {
    const section: NotebookSection = expert.writeSections[0];
    notebook.append(section, irKey(r.ir), r.ir, expert.id, { round, writer: expert });
  }
  return r;
}

/**
 * Caravan 閉ループを実行する。完了後、Oasis / Team Learning へ結果を永続化する。
 *
 * 予算判定: PLAN / EXECUTE の全 Expert 呼び出し直後に、Expert 予算と全体予算の両方を
 * 判定する（VERIFY より前に超過したら budget-exhausted で停止）。
 */
export async function runCaravan(opts: CaravanRunOptions): Promise<CaravanRunResult> {
  const budget: CaravanBudget = { ...DEFAULT_CARAVAN_BUDGET, ...opts.budget };
  const notebook = new CaravanNotebook(opts.task);
  const domain = detectCaravanDomain(opts.task);
  const verifier = opts.verifier ?? ((nb: CaravanNotebook) => verifyCaravanArtifact(nb, domain));
  // Dynamic Expert Formation: チームは実行中に拡張できる（Phase C）
  let team = [...opts.team];
  let teamKey = team.map((e) => e.id).join('>');
  let formedCount = 0;
  const maxFormation = opts.maxFormation ?? 1;
  const rounds: CaravanRoundLog[] = [];
  const expertSpent = new Map<string, number>();
  let spentMs = 0;
  let success = false;
  let stopReason: CaravanRunResult['stopReason'] = 'verified';
  let finalDiagnosis: NotebookEntry | undefined;

  const t0 = Date.now();

  outer: for (let round = 1; round <= budget.maxRounds; round++) {
    // ── PLAN + EXECUTE ──
    // チーム順（planning が先頭）で実行し、phase は writeSections で判定する。
    // 各呼び出し直後に Expert 予算と全体予算の両方を判定する。
    for (const ex of team) {
      if (!ex.execute) continue;
      const phase: CaravanPhase = ex.writeSections.includes('plan') ? 'PLAN' : 'EXECUTE';
      const r = await runExpert(notebook, ex, round, budget.thinkingBudgetMs - spentMs);
      spentMs += r.ms;
      rounds.push({ round, phase, note: `${ex.id}: ${r.ir.slice(0, 48)}`, spentMs: r.ms });
      if (!r.ok) {
        notebook.fail(ex.id, `実行失敗: ${r.ir.slice(0, 60)}`, { round });
        rounds.push({ round, phase: 'REPLAN', note: `${ex.id} 実行失敗 → 再計画`, spentMs: 0 });
      }
      const prior = expertSpent.get(ex.id) ?? 0;
      expertSpent.set(ex.id, prior + r.ms);
      if (prior + r.ms > budget.expertBudgetMs || spentMs > budget.thinkingBudgetMs) {
        stopReason = 'budget-exhausted';
        rounds.push({
          round,
          phase: 'REPLAN',
          note: `予算超過（expert=${ex.id}: ${prior + r.ms}ms / total=${spentMs}ms）`,
          spentMs: 0,
        });
        break outer;
      }
    }

    // ── OBSERVE（Notebook の現在状態が観測そのもの） ──
    rounds.push({ round, phase: 'OBSERVE', note: `entries=${notebook.size} / v${notebook.version}`, spentMs: 0 });

    // ── VERIFY（成果物検証） ──
    const v = verifier(notebook);
    rounds.push({ round, phase: 'VERIFY', note: v.ok ? 'PASS' : `FAIL(${v.issues.length})`, spentMs: 0 });
    if (v.ok) {
      success = true;
      stopReason = 'verified';
      finalDiagnosis = notebook.diagnose('master', '検証済みの成果物を確定', 0.9, [], { round });
      rounds.push({ round, phase: 'DIAGNOSIS', note: finalDiagnosis.value.slice(0, 48), spentMs: 0 });
      break;
    }

    // ── FAIL → ERRORS（REPLAN の入力。会話ログではなく「確定した失敗」だけ） ──
    notebook.fail('master', `VERIFY 失敗: ${v.issues.map((i) => i.message).join('; ').slice(0, 80)}`, { round });
    rounds.push({ round, phase: 'REPLAN', note: `検証失敗 → 再計画（errors=${notebook.entriesOf('errors').length}）`, spentMs: 0 });

    // ── Dynamic Expert Formation（Phase C）: 不足能力を推定し、Pool から Expert を attach ──
    const canForm =
      opts.formation !== undefined &&
      opts.pool !== undefined &&
      formedCount < maxFormation &&
      round < budget.maxRounds;
    if (canForm) {
      const ctx: FormationContext = {
        task: opts.task,
        notebook,
        domain,
        team,
        pool: opts.pool!,
        verification: v,
        round,
      };
      const decision = opts.formation!(ctx);
      if (decision.expertId !== null) {
        const p = opts.pool!.find((e) => e.id === decision.expertId);
        const already = team.some((t) => t.id === decision.expertId);
        if (p && !already) {
          const added = formationExpertFromPool(p, {
            readSections: decision.readSections,
            writeSections: decision.writeSections,
          }, domain);
          team = [...team, added];
          teamKey = team.map((e) => e.id).join('>');
          formedCount++;
          notebook.append(
            'decisions',
            'decision',
            `decision: [action=AddExpert, expert=${p.id}, reason="${decision.reason}"]`,
            'formation',
            { round },
          );
          rounds.push({ round, phase: 'REPLAN', note: `FORM: +${p.id}（${decision.reason}）`, spentMs: 0 });
          // 拡張したチームで次の Round を実行する
          continue;
        }
      }
    }

    if (spentMs > budget.thinkingBudgetMs) {
      stopReason = 'budget-exhausted';
      break;
    }
    if (round >= budget.maxRounds) {
      stopReason = 'max-rounds';
    }
  }

  // 失敗時にも最終診断を残す（成功時の診断は上で書いた）
  if (!success && !finalDiagnosis) {
    finalDiagnosis = notebook.diagnose('master', `未検証終了（${stopReason}）`, 0.3, [stopReason], { round: budget.maxRounds });
  }

  const totalMs = Date.now() - t0;
  const finalSnapshot = notebook.snapshot();
  const quality = success ? 0.9 : 0.3;
  const finalVerification = verifier(notebook);

  // 完了後に Oasis / Team Learning へ記録（Single Source of Truth の結果を永続化）
  if (opts.oasis) {
    opts.oasis.recordCaravan({
      task: opts.task,
      team: team.map((e) => e.id),
      result: success ? 'success' : 'fail',
      quality,
      lesson: makeLesson(opts.task, team.map((e) => e.id), success, quality),
      confidence: success ? 0.9 : 0.3,
      notebookSnapshot: finalSnapshot,
      plan: notebook.latest('plan')?.value,
      diagnosis: finalDiagnosis?.value,
    });
  }
  if (opts.learner) {
    opts.learner.record(teamKey, success, quality);
  }

  return {
    task: opts.task,
    team,
    teamKey,
    notebook,
    rounds,
    totalMs,
    success,
    stopReason,
    spentMs,
    remainingBudgetMs: Math.max(0, budget.thinkingBudgetMs - spentMs),
    verification: finalVerification,
    finalSnapshot,
    ...(finalDiagnosis !== undefined ? { finalDiagnosis } : {}),
  };
}

// ── 固定 Caravan（Phase A+B: 固定 Caravan + 固定 Expert） ──────────────────

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface FixedCaravanOptions {
  /** ドメイン明示（省略時 detectCaravanDomain） */
  domain?: CaravanDomain;
  /** 常に失敗（予算 / Round 枯渇テスト用）: タスクに /絶対に失敗|always-fail|never/ */
  alwaysFail?: boolean;
  /** 初回失敗 → REPLAN で成功（テスト用）: タスクに /再試行|retry|作り直し/ */
  failFirst?: boolean;
}

/**
 * 固定 Caravan のチームを組み立てる（決定論）。
 * - planning : PLAN セクションへ plan を書く
 * - ドメイン Expert（coding / math / search）: analysis セクションへ成果物 IR を書く
 */
export function fixedCaravan(task: string, opts: FixedCaravanOptions = {}): NotebookExpert[] {
  const domain = opts.domain ?? detectCaravanDomain(task);
  const alwaysFail = opts.alwaysFail ?? /絶対に失敗|always-fail|never/.test(task);
  const failFirst = opts.failFirst ?? /再試行|retry|作り直し|replan/.test(task);

  const planning: NotebookExpert = {
    id: 'planning',
    name: 'Planning',
    role: 'planning',
    readSections: ['task', 'errors'],
    writeSections: ['plan'],
    execute: async ({ task: t, round }) => ({
      ir: `plan: [steps=${2 + (hashStr(t + round) % 3)}, goal="${t.slice(0, 12)}"]`,
      ms: 20 + (hashStr(t + 'plan') % 15),
      ok: true,
    }),
  };

  const name = domain === 'coding' ? 'Coding' : domain === 'math' ? 'Math' : 'Search';
  const domainExpert: NotebookExpert = {
    id: domain,
    name,
    role: domain,
    readSections: ['task', 'plan'],
    writeSections: ['analysis'],
    execute: async ({ task: t, round }) => {
      const valid = !(alwaysFail || (failFirst && round === 1));
      if (domain === 'coding') {
        return {
          ir: valid
            ? `program: [plan=motor-control-v1, lines=${8 + (round % 4)}, round=${round}]`
            : 'program: [broken',
          ms: 25 + (hashStr(t + 'code') % 10),
          ok: true,
        };
      }
      if (domain === 'math') {
        return {
          ir: valid ? `solution: x=${1 + (hashStr(t) % 9)}` : 'solution: y=5',
          ms: 15 + (hashStr(t + 'math') % 10),
          ok: true,
        };
      }
      return {
        ir: valid ? `analysis: [hits=${1 + (hashStr(t) % 5)}, top="${t.slice(0, 8)}"]` : 'analysis: [broken',
        ms: 20 + (hashStr(t + 'search') % 10),
        ok: true,
      };
    },
  };

  return [planning, domainExpert];
}

/** Caravan 実行の表示（CLI） */
export function renderCaravan(r: CaravanRunResult): string {
  const lines: string[] = [];
  lines.push('═'.repeat(56));
  lines.push('Caravan Loop — Single Source of Truth for Task State');
  lines.push('═'.repeat(56));
  lines.push(`task   : ${r.task}`);
  lines.push(`team   : ${r.teamKey}`);
  lines.push(`result : ${r.success ? 'SUCCESS' : 'FAIL'} (${r.stopReason}) / ${r.totalMs}ms`);
  lines.push(`budget : spent=${r.spentMs}ms / remaining=${r.remainingBudgetMs}ms / rounds=${r.rounds.filter((x) => x.phase === 'PLAN').length}`);
  lines.push('');
  lines.push('rounds:');
  for (const lg of r.rounds) {
    lines.push(`  [r${lg.round} ${lg.phase.padEnd(9)}] ${lg.note} (${lg.spentMs}ms)`);
  }
  lines.push('');
  lines.push('notebook:');
  for (const line of r.notebook.render(3).split('\n')) {
    lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push(`verify : ${r.verification.ok ? 'PASS' : 'FAIL'} ${r.verification.issues.map((i) => i.message).join('; ')}`);
  return lines.join('\n');
}
