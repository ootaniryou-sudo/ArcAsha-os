/**
 * Caravan Verifier（Phase B）— 成果物そのものの検査（100% 決定論）
 *
 * 「回答の良さ」の評価ではなく「成果物の検査」を実装する:
 *   - coding: program アーティファクトの構造検証（build / test 相当）
 *   - math  : solution アーティファクトの構造検証（数値検証相当）
 *   - 任意  : AILSA program（Instruction[]）は ailsa/validator で検証（AILSA 接続）
 *
 * Notebook の IR 値は全て型付きデータとして保存され、ここで構造契約を検査する。
 * この Verifier は Notebook の現在状態（最新の plan / アーティファクト）だけを検査し、
 * 過去の ERRORS 履歴（REPLAN の入力）は判定に含めない。
 */
import { validateProgram } from '../ailsa/validator.js';
import type { Instruction } from '../ailsa/encoder.js';
import type { CaravanNotebook } from './notebook.js';

export type CaravanDomain = 'coding' | 'math' | 'generic';

export interface CaravanVerificationIssue {
  verifier: string; // Plan / Artifact / AILSA
  message: string;
}

export interface CaravanVerificationResult {
  ok: boolean;
  issues: CaravanVerificationIssue[];
}

/** タスク文から Caravan ドメインを判定（決定論。英語キーワードは大文字小文字非依存） */
export function detectCaravanDomain(task: string): CaravanDomain {
  if (/計算|方程式|解いて|求めて|math|solve|equation|sum/i.test(task)) return 'math';
  if (/実装|コード|プログラミング|関数|バグ|作って|coding|implement|program/i.test(task)) return 'coding';
  return 'generic';
}

/** AILSA program の検証（ailsa/validator.validateProgram へ接続） */
export function verifyAilsaProgram(instructions: readonly Instruction[]): CaravanVerificationResult {
  const v = validateProgram([...instructions]);
  return {
    ok: v.valid,
    issues: v.issues.map((i) => ({ verifier: 'AILSA', message: `[${i.index}] ${i.message}` })),
  };
}

/** 指定セクション内で指定 key の最新エントリを返す（セクション境界を強制） */
function latestInSection(
  notebook: CaravanNotebook,
  section: 'plan' | 'analysis',
  key: string,
): { value: string } | undefined {
  const es = notebook.entriesOf(section);
  for (let i = es.length - 1; i >= 0; i--) {
    if (es[i].key === key) return es[i];
  }
  return undefined;
}

/**
 * Notebook の成果物を構造検証する。
 * - PLAN セクションに plan が存在し、IR 形式（plan: ...）であること
 * - ドメイン別のアーティファクト（program / solution / analysis）が ANALYSIS セクションに
 *   存在し、IR 形式であること（key だけでなくセクションでも制約）
 */
export function verifyCaravanArtifact(
  notebook: CaravanNotebook,
  domain: CaravanDomain = 'generic',
): CaravanVerificationResult {
  const issues: CaravanVerificationIssue[] = [];

  // 1. PLAN が必要（実行組織としての最低契約）。plan は plan セクションから取得
  const plan = latestInSection(notebook, 'plan', 'plan');
  if (!plan) {
    issues.push({ verifier: 'Plan', message: 'PLAN セクションに plan が無い' });
  } else if (!/^plan:\s*\[/.test(plan.value)) {
    issues.push({ verifier: 'Plan', message: `plan が IR 形式でない: ${plan.value.slice(0, 40)}` });
  }

  // 2. ドメイン別のアーティファクト検査（成果物検証）。program / solution / analysis は analysis セクションから
  if (domain === 'coding') {
    const program = latestInSection(notebook, 'analysis', 'program');
    if (!program) {
      issues.push({ verifier: 'Artifact', message: 'coding: analysis セクションに program が無い' });
    } else if (!/^program:\s*\[[^\]]*\]$/.test(program.value)) {
      issues.push({ verifier: 'Artifact', message: `program が閉じた IR 形式でない: ${program.value.slice(0, 40)}` });
    }
  } else if (domain === 'math') {
    const solution = latestInSection(notebook, 'analysis', 'solution');
    if (!solution) {
      issues.push({ verifier: 'Artifact', message: 'math: analysis セクションに solution が無い' });
    } else {
      // 実際に数値として検証する（空値・非数値を拒否）
      const m = /^solution:\s*x=([0-9.+-]+)$/.exec(solution.value);
      const raw = m?.[1];
      if (!m || raw === undefined || raw.trim() === '' || !Number.isFinite(Number(raw))) {
        issues.push({ verifier: 'Artifact', message: `solution が数値 IR 形式でない: ${solution.value.slice(0, 40)}` });
      }
    }
  } else {
    const analysis = latestInSection(notebook, 'analysis', 'analysis');
    if (!analysis) {
      issues.push({ verifier: 'Artifact', message: 'generic: analysis セクションに analysis が無い' });
    } else if (!/^analysis:\s*\[[^\]]*\]$/.test(analysis.value)) {
      issues.push({ verifier: 'Artifact', message: `analysis が閉じた IR 形式でない: ${analysis.value.slice(0, 40)}` });
    }
  }

  return { ok: issues.length === 0, issues };
}
