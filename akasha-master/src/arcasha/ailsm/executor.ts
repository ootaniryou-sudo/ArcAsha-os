/**
 * AILSM Executor — IRをLLM無しで実行するエンジン
 *
 * AILSMは状態を持つSSAプログラム。Executorは組み込み演算（ADD/SUBTRACT/...）を
 * 100%決定論で実行し、Resultノードを追加してグラフを更新する。
 *
 *   Task#1 (actions=[ACTION_ADD])
 *     ├─ Value#1 = 2
 *     └─ Value#2 = 3
 *   ── execute ──▶
 *   Task#1
 *     ├─ Value#1 = 2
 *     ├─ Value#2 = 3
 *     └─ Value#3 : result = 5   （produces）
 *
 * ローカルで解決できなければ needsExpert=true（CALL/RETURN で Expert へ委譲）。
 * これが「Expert = CPU」の実行モデル（AILSA Runtime）の基盤になる。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import type { CanonicalAction } from './normalizer.js';

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

export interface ExecutorResult {
  before: AilsmGraph;
  after: AilsmGraph;
  resolved: boolean;
  needsExpert: boolean;
  value: number | string | null;
  steps: string[];
}

interface BinaryOp {
  symbol: string;
  op: (a: number, b: number) => number;
}

interface UnaryOp {
  symbol: string;
  op: (a: number) => number;
}

const BINARY_OPS: Partial<Record<CanonicalAction, BinaryOp>> = {
  ACTION_ADD: { symbol: '+', op: (a, b) => a + b },
  ACTION_SUBTRACT: { symbol: '-', op: (a, b) => a - b },
  ACTION_MULTIPLY: { symbol: '×', op: (a, b) => a * b },
  ACTION_DIVIDE: {
    symbol: '÷',
    op: (a, b) => {
      if (b === 0) throw new ExecutorError('0除算');
      return a / b;
    },
  },
};

const UNARY_OPS: Partial<Record<CanonicalAction, UnaryOp>> = {
  ACTION_SQRT: {
    symbol: '√',
    op: (a) => {
      if (a < 0) throw new ExecutorError('負の数の平方根');
      return Math.sqrt(a);
    },
  },
  ACTION_SQUARE: { symbol: '^2', op: (a) => a * a },
};

function numericValues(g: AilsmGraph): { id: number; value: number }[] {
  const out: { id: number; value: number }[] = [];
  for (const n of g.nodes) {
    if (n.kind !== 'value' || n.type !== 'number') continue;
    // value 属性を優先（属性の挿入順に依存しない）。min/max などの制約値を誤って
    // 演算オペランドに使わないようにする。
    const v = n.attrs.value;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.push({ id: n.id, value: v });
      continue;
    }
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      out.push({ id: n.id, value: Number(v) });
      continue;
    }
    // value 属性が無い場合は他の数値属性から探す（フォールバック）
    for (const attr of Object.values(n.attrs)) {
      if (typeof attr === 'number' && Number.isFinite(attr)) {
        out.push({ id: n.id, value: attr });
        break;
      }
      if (typeof attr === 'string' && attr.trim() !== '' && Number.isFinite(Number(attr))) {
        out.push({ id: n.id, value: Number(attr) });
        break;
      }
    }
  }
  return out;
}

function rebuildWithResult(g: AilsmGraph, resultValue: number | null): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const task = g.nodes.find((n) => n.kind === 'task');
  if (resultValue !== null && task) {
    const taskId = remap.get(task.id)!;
    const resultId = b.addNode('value', 'result', 'number', { value: resultValue });
    b.connect(taskId, resultId, 'produces');
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

/** AILSMグラフを実行し、組み込み演算をローカル解決する（100%決定論） */
export function execute(g: AilsmGraph): ExecutorResult {
  const task = g.nodes.find((n) => n.kind === 'task');
  const actions = (task?.attrs.actions as string[] | undefined) ?? [];
  const intent = String(task?.attrs.intent ?? 'unknown');
  const domain = String(task?.attrs.domain ?? 'unknown');
  const hasConstant = g.nodes.some((n) => n.kind === 'value' && n.label === 'constant');
  const steps: string[] = [];

  let resolvedValue: number | null = null;
  let builtinResolved = false;

  for (const action of actions) {
    const canon = action as CanonicalAction;
    const bin = BINARY_OPS[canon];
    if (bin) {
      const nums = numericValues(g);
      if (nums.length >= 2) {
        const [a, b] = [nums[0].value, nums[1].value];
        try {
          resolvedValue = bin.op(a, b);
          steps.push(`${canon}(${a} ${bin.symbol} ${b}) = ${resolvedValue}`);
          builtinResolved = true;
          break;
        } catch (err) {
          steps.push(`${canon}: ${(err as Error).message}`);
          break;
        }
      }
    }
    const un = UNARY_OPS[canon];
    if (un) {
      const nums = numericValues(g);
      if (nums.length >= 1) {
        const a = nums[0].value;
        try {
          resolvedValue = un.op(a);
          steps.push(`${canon}(${un.symbol}${a}) = ${resolvedValue}`);
          builtinResolved = true;
          break;
        } catch (err) {
          steps.push(`${canon}: ${(err as Error).message}`);
          break;
        }
      }
    }
  }

  // ローカル解決 = 組み込み演算 or コンパイル時の定数畳み込み
  const resolved = builtinResolved || hasConstant;
  // Expert 委譲が必要なタスク: 未解決 かつ（アクション / 専門意図 / 既知ドメイン）
  const expertIntent =
    intent === 'search' || intent === 'summarize' || intent === 'verify' || intent === 'code' || intent === 'create';
  const needsExpert = !resolved && (actions.length > 0 || expertIntent || domain !== 'unknown');

  const after = rebuildWithResult(g, resolved ? resolvedValue : null);

  return {
    before: g,
    after,
    resolved,
    needsExpert,
    value: resolved ? resolvedValue : null,
    steps,
  };
}