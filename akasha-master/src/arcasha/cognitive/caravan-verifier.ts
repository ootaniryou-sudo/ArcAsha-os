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

/** タスク文から Caravan ドメインを判定（決定論） */
export function detectCaravanDomain(task: string): CaravanDomain {
  if (/計算|方程式|解いて|求めて|math|solve|equation|sum/.test(task)) return 'math';
  if (/実装|コード|プログラミング|関数|バグ|作って|coding|implement|program/.test(task)) return 'coding';
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

/**
 * Notebook の成果物を構造検証する。
 * - PLAN セクションに plan が存在し、IR 形式（plan: ...）であること
 * - ドメイン別のアーティファクト（program / solution / analysis）が存在し、IR 形式であること
 */
export function verifyCaravanArtifact(
  notebook: CaravanNotebook,
  domain: CaravanDomain = 'generic',
): CaravanVerificationResult {
  const issues: CaravanVerificationIssue[] = [];

  // 1. PLAN が必要（実行組織としての最低契約）
  const plan = notebook.latest('plan');
  if (!plan) {
    issues.push({ verifier: 'Plan', message: 'PLAN セクションに plan が無い' });
  } else if (!/^plan:\s*\[/.test(plan.value)) {
    issues.push({ verifier: 'Plan', message: `plan が IR 形式でない: ${plan.value.slice(0, 40)}` });
  }

  // 2. ドメイン別のアーティファクト検査（成果物検証）
  if (domain === 'coding') {
    const program = notebook.latest('program');
    if (!program) {
      issues.push({ verifier: 'Artifact', message: 'coding: program アーティファクトが無い' });
    } else if (!/^program:\s*\[[^\]]*\]$/.test(program.value)) {
      issues.push({ verifier: 'Artifact', message: `program が閉じた IR 形式でない: ${program.value.slice(0, 40)}` });
    }
  } else if (domain === 'math') {
    const solution = notebook.latest('solution');
    if (!solution) {
      issues.push({ verifier: 'Artifact', message: 'math: solution アーティファクトが無い' });
    } else if (!/^solution:\s*x=[0-9.+-]+$/.test(solution.value)) {
      issues.push({ verifier: 'Artifact', message: `solution が数値 IR 形式でない: ${solution.value.slice(0, 40)}` });
    }
  } else {
    const analysis = notebook.latest('analysis');
    if (!analysis) {
      issues.push({ verifier: 'Artifact', message: 'generic: analysis が無い' });
    } else if (!/^analysis:\s*\[[^\]]*\]$/.test(analysis.value)) {
      issues.push({ verifier: 'Artifact', message: `analysis が閉じた IR 形式でない: ${analysis.value.slice(0, 40)}` });
    }
  }

  return { ok: issues.length === 0, issues };
}
