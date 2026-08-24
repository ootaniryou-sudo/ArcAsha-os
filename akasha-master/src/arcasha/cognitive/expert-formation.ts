/**
 * Expert Formation Policy（Phase C / PR 3）— 失敗から不足能力を推定し、Caravan へ Expert を動的編成する
 *
 * 「浮動している専門 AI の凸凹を Caravan が組み合わせ、一時的なタスク専用 AI を作る」構想の実装。
 *
 *   Failure
 *     ↓
 *   Notebook（ERRORS / DECISIONS / 検証結果）
 *     ↓
 *   不足能力を推定（inferMissingCapability）
 *     ↓
 *   Pool / Capability Graph（候補 Expert）
 *     ↓
 *   候補ランキング（cost / latency / capability）
 *     ↓
 *   Expert 選択（defaultFormationPolicy）
 *     ↓
 *   Caravan へ attach（formationExpertFromPool: Notebook を必要部分だけ共有）
 *     ↓
 *   再実行（runCaravan の次の Round）
 *
 * 設計契約:
 *   - Notebook が状態。編成決定は Notebook.DECISIONS に
 *     `decision: [action=AddExpert, expert=..., reason="..."]` として記録される
 *     （RecoveryHarness の AddExpert 戦略と同じ IR 形式。両者は DECISIONS で接続される）。
 *   - PoolExpert に execute が無い場合は決定論 Simulation で IR を生成する
 *     （「Cognitive Graph の仕組み」と「実モデル接続」を同一インターフェースで扱う）。
 *   - 既存の composeTeam / detectRoles（capability-graph）を再利用して型ベースの補完を行う。
 *
 * スコープ（入れる）: 不足能力推定 / 候補ランキング / Expert 選択 / Caravan への attach /
 *   決定論 Simulation / Need-to-know（readSections / writeSections）
 * スコープ外: 実モデル性能比較 / 大規模 Policy Learning（Oasis ベースの学習は後続）
 *
 * 研究姿勢: 本モジュールは「検証失敗から不足能力を推定し、Pool から Expert を選んで
 * Caravan を動的に変形できる」ことを証明する。性能改善は主張しない。
 */
import type { PoolExpert } from './pool.js';
import type { CaravanNotebook, NotebookExpert, NotebookSection } from './notebook.js';
import { notebookExpertFromPool } from './notebook.js';
import type { CaravanDomain, CaravanVerificationResult } from './caravan-verifier.js';
import { detectRoles } from './capability-graph.js';

/** 編成判断の入力（読み取り専用。Notebook が状態の出所） */
export interface FormationContext {
  task: string;
  notebook: CaravanNotebook;
  domain: CaravanDomain;
  /** 現在のチーム（編成前） */
  team: readonly NotebookExpert[];
  /** AI Pool */
  pool: readonly PoolExpert[];
  /** 直近の検証結果 */
  verification: CaravanVerificationResult;
  round: number;
}

/** 編成決定。追加する Expert と、その Need-to-know 契約（Notebook.DECISIONS に記録される） */
export interface FormationDecision {
  /** 追加する Pool Expert の id。null = 追加しない */
  expertId: string | null;
  /** 追加する役割（能力）。DECISIONS の addedCapability として記録する（RecoveryHarness と統一） */
  addedCapability?: string;
  /** 追加理由（DECISIONS に残す根拠） */
  reason: string;
  /** 読めるセクション（部分供給 = Need-to-know） */
  readSections: readonly NotebookSection[];
  /** 書けるセクション */
  writeSections: readonly NotebookSection[];
}

/** 編成ポリシー（差し替え可。ルールベース → 学習 → Oasis ベースへ発展できる） */
export type ExpertFormationPolicy = (ctx: FormationContext) => FormationDecision;

/** 役割ごとの Notebook I/O 契約（Need-to-know。Expert に必要な部分だけ供給する） */
const ROLE_IO: Record<string, { read: readonly NotebookSection[]; write: readonly NotebookSection[] }> = {
  planning: { read: ['task', 'errors'], write: ['plan'] },
  coding: { read: ['task', 'context', 'plan', 'analysis'], write: ['analysis'] },
  math: { read: ['task', 'context', 'plan'], write: ['analysis'] },
  search: { read: ['task', 'context'], write: ['analysis'] },
  vision: { read: ['task', 'context'], write: ['analysis'] },
  physics: { read: ['task', 'context'], write: ['analysis'] },
  robot: { read: ['task', 'context'], write: ['analysis'] },
  memory: { read: ['task', 'context', 'analysis', 'decisions', 'errors'], write: ['context'] },
};

/** 検証失敗 / エラーメッセージから不足能力を推定するヒント（決定論） */
const CAPABILITY_HINTS: readonly [string, RegExp][] = [
  ['coding', /program|実装|コード|coding|implement/],
  ['math', /solution|数値|計算|math|solve|equation/],
  ['planning', /plan|計画/],
  ['search', /analysis|検索|search/],
  ['vision', /vision|画像|検出|camera/],
  ['physics', /physics|軌道|飛行|trajectory/],
  ['robot', /robot|ロボット|drone/],
];

/**
 * 不足能力を推定する（決定論）。
 * 1. 検証結果（不足アーティファクトの役割）
 * 2. Notebook.ERRORS（実行失敗・検証失敗）
 * 3. Notebook.DECISIONS の addedCapability（RecoveryHarness の AddExpert 決定との接続点）
 * 4. ドメインの成果物を生む役割（coding → program / math → solution）
 * 5. タスク由来の役割（capability-graph.detectRoles）
 * 既にチームにいる役割は除外する。
 */
export function inferMissingCapability(ctx: FormationContext): string[] {
  const teamRoles = new Set(ctx.team.map((e) => e.role));
  const missing: string[] = [];
  const seen = new Set<string>();
  const addIfMissing = (cap: string): void => {
    if (cap && !teamRoles.has(cap) && !seen.has(cap)) {
      seen.add(cap);
      missing.push(cap);
    }
  };

  // 1. 検証結果（不足アーティファクト）
  for (const issue of ctx.verification.issues) {
    for (const [cap, re] of CAPABILITY_HINTS) {
      if (re.test(issue.message)) {
        addIfMissing(cap);
        break;
      }
    }
  }
  // 2. Notebook.ERRORS
  for (const err of ctx.notebook.entriesOf('errors')) {
    for (const [cap, re] of CAPABILITY_HINTS) {
      if (re.test(err.value)) {
        addIfMissing(cap);
        break;
      }
    }
  }
  // 3. DECISIONS の addedCapability / expert（AddExpert 決定。RecoveryHarness と Formation の両方に対応）
  for (const d of ctx.notebook.entriesOf('decisions')) {
    const added = /addedCapability=([a-z][a-z0-9_-]*)/.exec(d.value);
    if (added) addIfMissing(added[1]);
    const ex = /expert=([a-z][a-z0-9_-]*)/.exec(d.value);
    if (ex) addIfMissing(ex[1]);
  }
  // 4. ドメインの成果物を生む役割
  if (ctx.domain === 'coding') addIfMissing('coding');
  if (ctx.domain === 'math') addIfMissing('math');
  // 5. タスク由来の役割（Capability Graph）
  for (const role of detectRoles(ctx.task)) addIfMissing(role);
  return missing;
}

/**
 * 候補 Expert をランキングする（決定論）。
 * 不足能力の順序を優先し、同じ能力内では cost → latency の昇順。
 */
export function rankCandidateExperts(
  pool: readonly PoolExpert[],
  missing: readonly string[],
  team: readonly NotebookExpert[],
): PoolExpert[] {
  const have = new Set(team.map((e) => e.id));
  const ranked: PoolExpert[] = [];
  const seen = new Set<string>();
  for (const cap of missing) {
    const matches = pool
      .filter((e) => e.role === cap && !have.has(e.id))
      .sort((a, b) => a.cost - b.cost || a.latencyMs - b.latencyMs);
    for (const m of matches) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        ranked.push(m);
      }
    }
  }
  return ranked;
}

/**
 * 既定の編成ポリシー（決定論）。
 * 不足能力を推定 → Pool から候補をランキング → 最有力 1 名を選択。
 * 追加候補が無ければ expertId=null（編成しない）。
 */
export function defaultFormationPolicy(ctx: FormationContext): FormationDecision {
  const missing = inferMissingCapability(ctx);
  const candidates = rankCandidateExperts(ctx.pool, missing, ctx.team);
  const best = candidates[0];
  if (!best) {
    return { expertId: null, reason: '追加候補なし（不足能力を推定できず）', readSections: [], writeSections: [] };
  }
  const io = ROLE_IO[best.role] ?? { read: ['task', 'context'] as const, write: ['analysis'] as const };
  return {
    expertId: best.id,
    addedCapability: best.role,
    reason: `不足能力 "${best.role}" を補完（cost=${best.cost}, latency=${best.latencyMs}ms）`,
    readSections: io.read,
    writeSections: io.write,
  };
}

/** 決定論 Simulation IR（PoolExpert に execute が無い場合。outputType / ドメインに応じた IR） */
function simulationIr(p: PoolExpert, domain: CaravanDomain, task: string, round: number): string {
  if (p.role === 'coding' || domain === 'coding') return `program: [plan=formation-v${round}, lines=${6 + (round % 4)}]`;
  if (p.role === 'math' || domain === 'math') return `solution: x=${1 + (round % 9)}`;
  if (p.role === 'planning') return `plan: [steps=${2 + (round % 3)}, goal="${task.slice(0, 12)}"]`;
  if (p.role === 'search') return `analysis: [hits=${1 + (round % 5)}, top="${task.slice(0, 8)}"]`;
  return `${p.outputType}: [via=${p.id}, round=${round}]`;
}

/**
 * PoolExpert を Caravan のメンバー（NotebookExpert）へ変換して attach する。
 * PoolExpert に execute が無い場合は決定論 Simulation で IR を生成する
 * （「Cognitive Graph の仕組み」と「実モデル接続」を同一インターフェースで扱う）。
 */
export function formationExpertFromPool(
  p: PoolExpert,
  io: { readSections: readonly NotebookSection[]; writeSections: readonly NotebookSection[] },
  domain: CaravanDomain,
): NotebookExpert {
  const base = notebookExpertFromPool(p, io);
  if (base.execute) return base;
  return {
    ...base,
    execute: async ({ task, round }) => {
      const ir = simulationIr(p, domain, task, round);
      return { ir, ms: 15 + (round % 7), ok: true };
    },
  };
}

/** IR 文字列へ埋め込む値の構造文字（\ " [ ]）を、IR 構造を壊さない形へ変換する */
function irEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\[/g, '(').replace(/\]/g, ')');
}

/** 編成決定を Notebook.DECISIONS に書ける IR へ整形する（RecoveryHarness の AddExpert と同じ形式） */
export function formatFormationDecision(d: FormationDecision): string {
  if (d.expertId === null) return `decision: [action=NoAdd, reason="${irEscape(d.reason)}"]`;
  const cap = d.addedCapability !== undefined ? `, addedCapability=${d.addedCapability}` : '';
  return `decision: [action=AddExpert, expert=${d.expertId}, reason="${irEscape(d.reason)}"${cap}]`;
}
