/**
 * AILSA Generator — AILSM → AILSA命令列（Back-End Compiler）
 *
 * AILSMグラフを読み、Phase 0 の命令セット（AILSA ISA）へ変換する。
 * 生成された命令列は Phase 0 の Validator / Codec で再検証される。
 *
 * 生成ルール（充実版）:
 *   - CALL に SLOT_DOMAIN を付与（ルーティング情報）
 *   - ドメイン既知なら DOMAIN_* 命令を出力（CALL 直後）
 *   - Constant Folding で確定した値は SLOT_INPUT として伝達
 */

import { Domain, Slot, Task } from '../ailsa/vocab.js';
import { Opcode } from '../ailsa/opcode.js';
import { CodeOpcode, MathOpcode } from '../ailsa/dialect.js';
import type { Instruction } from '../ailsa/encoder.js';
import type { AilsmGraph } from './ailsm.js';
import type { CanonicalAction } from './normalizer.js';

const TASK_OF_INTENT: Record<string, Task> = {
  solve: Task.SOLVE,
  summarize: Task.SUMMARIZE,
  search: Task.SEARCH,
  verify: Task.VERIFY,
  code: Task.PATCH,
  create: Task.SOLVE,
};

const EXPERT_OF_DOMAIN: Record<string, string> = {
  math: 'math',
  code: 'programming',
  search: 'search',
  reasoning: 'reasoning',
};

const DOMAIN_OF_NAME: Record<string, Domain> = {
  math: Domain.MATH,
  code: Domain.CODE,
  search: Domain.SEARCH,
  reasoning: Domain.REASONING,
};

const OPCODE_OF_ACTION: Partial<Record<CanonicalAction, MathOpcode>> = {
  ACTION_ADD: MathOpcode.ADD,
  ACTION_SUBTRACT: MathOpcode.SUBTRACT,
  ACTION_MULTIPLY: MathOpcode.MULTIPLY,
  ACTION_DIVIDE: MathOpcode.DIVIDE,
  ACTION_SQRT: MathOpcode.SQRT,
  ACTION_SQUARE: MathOpcode.SQUARE,
  ACTION_INTEGRAL: MathOpcode.INTEGRAL,
  ACTION_DERIVE: MathOpcode.DERIVE,
  ACTION_LIMIT: MathOpcode.LIMIT,
  ACTION_EQUATION: MathOpcode.EQ,
  ACTION_MATRIX: MathOpcode.MATRIX,
};

/** コードファイル操作アクション → Code 方言オペコード（SWE / registry v1.3.0） */
const CODE_OPCODE_OF_ACTION: Partial<Record<CanonicalAction, CodeOpcode>> = {
  ACTION_READ_FILE: CodeOpcode.READ_FILE,
  ACTION_GREP: CodeOpcode.GREP,
  ACTION_EDIT_FILE: CodeOpcode.EDIT_FILE,
  ACTION_RUN_COMMAND: CodeOpcode.RUN_COMMAND,
};

type SlotValue = { slot: number; value: string | number | boolean };

/** スロット追加（重複時は既存値に追記して結合 — スロット重複を構造的に防ぐ） */
function addSlot(slots: SlotValue[], slot: number, value: string | number | boolean): void {
  const existing = slots.find((s) => s.slot === slot);
  if (existing) {
    existing.value = `${String(existing.value)} ${String(value)}`.trim();
  } else {
    slots.push({ slot, value });
  }
}

export function generateAilsa(g: AilsmGraph): Instruction[] {
  const instrs: Instruction[] = [];
  const task = g.nodes.find((n) => n.kind === 'task');
  if (!task) return instrs;

  const domain = String(task.attrs.domain ?? 'unknown');
  const intent = String(task.attrs.intent ?? 'unknown');
  const expert = EXPERT_OF_DOMAIN[domain] ?? 'general';
  const tid = '0';
  const domainOp = DOMAIN_OF_NAME[domain];

  // CALL（SLOT_DOMAIN 付与）
  const callSlots: SlotValue[] = [
    { slot: Slot.EXPERT, value: expert },
    { slot: Slot.TASK_ID, value: tid },
  ];
  if (domainOp) callSlots.push({ slot: Slot.DOMAIN, value: domain });
  instrs.push({ opcode: Opcode.CALL, slots: callSlots });

  // ドメイン宣言（CALL 直後）
  if (domainOp) instrs.push({ opcode: domainOp });

  const goalSlots: SlotValue[] = [];
  addSlot(goalSlots, Slot.GOAL, task.label);
  if (task.attrs.output) addSlot(goalSlots, Slot.OUTPUT, String(task.attrs.output));

  // 要約/検索/コード操作など: 入力テキストを SLOT_INPUT へ
  const inputNode = g.nodes.find((n) => n.kind === 'value' && n.label === 'input');
  const inputText = inputNode ? String((inputNode.attrs.text as string | undefined) ?? '') : '';
  if (inputText) addSlot(goalSlots, Slot.INPUT, inputText);

  // 入力式 / 定数畳み込み結果
  const equation = g.nodes.find((n) => n.type === 'equation');
  const constant = g.nodes.find((n) => n.kind === 'value' && n.label === 'constant');
  const inputExpr = equation ? String((equation.attrs.expr as string | undefined) ?? '') : null;
  const foldedValue = constant ? String((constant.attrs.value as number | undefined) ?? '') : null;

  // 数学アクション → 数学オペコード / コード操作アクション → Code 方言オペコード
  const actions = (task.attrs.actions as string[] | undefined) ?? [];
  let mathOpEmitted = 0;
  for (const action of actions) {
    const op = OPCODE_OF_ACTION[action as CanonicalAction];
    const cop = CODE_OPCODE_OF_ACTION[action as CanonicalAction];
    if (op === undefined && cop === undefined) {
      addSlot(goalSlots, Slot.GOAL, action);
      continue;
    }
    if (op !== undefined) {
      // 数学オペコード（方程式の入力式が必要）
      if (inputExpr) {
        instrs.push({ opcode: op, slots: [{ slot: Slot.INPUT, value: inputExpr }] });
        mathOpEmitted++;
      } else {
        addSlot(goalSlots, Slot.GOAL, action);
      }
      continue;
    }
    // コード方言オペコード（GREP / READ_FILE / EDIT_FILE / RUN_COMMAND）
    // domain=code のときだけ命令化（要約文の「読む」等が誤爆しないようガード）
    if (cop !== undefined && domain === 'code') {
      if (inputText) {
        instrs.push({ opcode: cop, slots: [{ slot: Slot.INPUT, value: inputText }] });
      } else {
        addSlot(goalSlots, Slot.GOAL, action);
      }
    }
  }

  // 方程式があり数学オペコード未出力 → 既定の EQ
  if (inputExpr && mathOpEmitted === 0) {
    instrs.push({ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: inputExpr }] });
  }

  // 定数畳み込み結果は SLOT_INPUT として伝達（オペコードは不要 — 値が確定済み）
  if (foldedValue) addSlot(goalSlots, Slot.INPUT, foldedValue);

  // タスク動詞を選ぶ。code ドメインでは実行したアクションに応じて適切なタスクを選ぶ
  // （READ/GREP → 検索タスク、EDIT → 修正タスク、RUN_COMMAND → 実行タスク）。
  let taskOp: Task;
  if (domain === 'code') {
    const codeActs = actions.filter((a) => CODE_OPCODE_OF_ACTION[a as CanonicalAction] !== undefined);
    if (codeActs.some((a) => a === 'ACTION_EDIT_FILE')) {
      taskOp = Task.PATCH;
    } else if (codeActs.some((a) => a === 'ACTION_READ_FILE' || a === 'ACTION_GREP')) {
      taskOp = Task.SEARCH;
    } else if (codeActs.some((a) => a === 'ACTION_RUN_COMMAND')) {
      taskOp = Task.SOLVE;
    } else {
      taskOp = TASK_OF_INTENT[intent] ?? Task.PATCH;
    }
  } else {
    taskOp = TASK_OF_INTENT[intent] ?? Task.SOLVE;
  }
  instrs.push({ opcode: taskOp, slots: goalSlots });
  instrs.push({ opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: tid }] });

  return instrs;
}
