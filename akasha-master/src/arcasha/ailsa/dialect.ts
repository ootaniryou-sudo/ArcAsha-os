/**
 * AILSA Dialect — エキスパート固有の命令サブセット
 *
 * LLVM のターゲット（x86 / ARM / RISC-V）と同じ発想。
 * Base ISA は全エキスパート必須。各 Dialect は自分の命令だけを実装すればよい。
 * 所属判定は registry.json（唯一の権威）の dialect フィールドに基づく。
 */

import { DialectId, entryOfOpcode } from './vocab.js';

/** 専門IRオペコード（0x40–0x7F） */
export enum MathOpcode {
  EQ = 0x41,
  DERIVE = 0x42,
  LIMIT = 0x43,
  MATRIX = 0x44,
  INTEGRAL = 0x45,
  ADD = 0x46,
  SUBTRACT = 0x47,
  MULTIPLY = 0x48,
  DIVIDE = 0x49,
  SQRT = 0x4a,
  SQUARE = 0x4b,
}

export enum CodeOpcode {
  FUNCTION = 0x51,
  CLASS = 0x52,
  PATCH = 0x53,
  BUILD = 0x54,
  TEST = 0x55,
  // ── SWE オペレーション（registry v1.3.0+） ──
  GREP = 0x56,
  READ_FILE = 0x57,
  EDIT_FILE = 0x58,
  RUN_COMMAND = 0x59,
}

export enum SearchOpcode {
  QUERY = 0x61,
  EXTRACT = 0x62,
}

export enum ReasoningOpcode {
  CAUSE = 0x71,
  GOAL = 0x72,
}

export interface Dialect {
  readonly id: DialectId;
  readonly label: string;
  /** この Dialect がその opcode を処理できるか（Base ISA を含む） */
  supports(opcode: number): boolean;
}

function isBaseOr(opcode: number, d: DialectId): boolean {
  const e = entryOfOpcode(opcode);
  if (!e) return false;
  return e.dialect === 'base' || e.dialect === d;
}

export const BASE: Dialect = {
  id: 'base',
  label: 'Base ISA',
  supports: (opcode) => entryOfOpcode(opcode)?.dialect === 'base',
};

export const MATH: Dialect = {
  id: 'math',
  label: 'Math Dialect',
  supports: (opcode) => isBaseOr(opcode, 'math'),
};

export const CODE: Dialect = {
  id: 'code',
  label: 'Code Dialect',
  supports: (opcode) => isBaseOr(opcode, 'code'),
};

export const SEARCH: Dialect = {
  id: 'search',
  label: 'Search Dialect',
  supports: (opcode) => isBaseOr(opcode, 'search'),
};

export const REASONING: Dialect = {
  id: 'reasoning',
  label: 'Reasoning Dialect',
  supports: (opcode) => isBaseOr(opcode, 'reasoning'),
};

export const DIALECTS: Record<DialectId, Dialect> = {
  base: BASE,
  math: MATH,
  code: CODE,
  search: SEARCH,
  reasoning: REASONING,
};

export function getDialect(id: DialectId): Dialect {
  return DIALECTS[id];
}
