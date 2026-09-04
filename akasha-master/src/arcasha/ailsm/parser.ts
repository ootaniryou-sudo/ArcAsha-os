/**
 * AILSM Parser — Stage 1: NormalizedInput → SSA風ID付き意味グラフ
 *
 * タスク/オブジェクト/値のノードを生成し、ID参照（uses / input）で接続する。
 */

import { AilsmBuilder } from './ailsm.js';
import { CODE_ACTION_SET } from './normalizer.js';
import { objectType } from './types.js';
import type { NormalizedInput } from './normalizer.js';

export function parse(norm: NormalizedInput): AilsmBuilder {
  const b = new AilsmBuilder();

  const taskAttrs: Record<string, string | number | boolean | string[]> = {
    domain: norm.domain,
    intent: norm.intent,
  };
  if (norm.actions.length > 0) taskAttrs.actions = norm.actions;
  if (norm.output) taskAttrs.output = norm.output;

  const taskId = b.addNode('task', norm.intent === 'unknown' ? 'process' : norm.intent, 'unknown', taskAttrs);

  // 入力テキストは「指示の対象」としてグラフに載せる。
  // summarize/search/create/code の意図に加え、コードファイル操作
  // （読む/検索/編集/実行）でも入力（パス・パターン等）が存在する。
  if (
    norm.inputText &&
    (norm.intent === 'summarize' ||
      norm.intent === 'search' ||
      norm.intent === 'create' ||
      norm.intent === 'code' ||
      norm.actions.some((a) => CODE_ACTION_SET.has(a)))
  ) {
    const n = b.addNode('value', 'input', 'string', { text: norm.inputText });
    b.connect(taskId, n, 'input');
  }

  for (const obj of norm.objects) {
    const id = b.addNode('object', obj, objectType(obj));
    b.connect(taskId, id, 'uses');
  }

  for (const a of norm.attributes) {
    const numeric = a.value !== '';
    const id = b.addNode(
      'value',
      a.name,
      numeric ? 'number' : 'string',
      { [a.name]: a.value },
      numeric ? { min: 0 } : undefined, // 例: 半径・直径・辺は正の値（制約の実演）
    );
    b.connect(taskId, id, 'uses');
  }

  for (const expr of norm.rawMath) {
    const id = b.addNode('object', 'equation', 'equation', { expr });
    b.connect(taskId, id, 'uses');
  }

  // 四則演算の入力値（アクションがある場合のみ数値ノード化）
  if (norm.actions.length > 0) {
    for (const num of norm.numbers) {
      const id = b.addNode('value', 'number', 'number', { value: num });
      b.connect(taskId, id, 'uses');
    }
  }

  for (const v of norm.variables) {
    const id = b.addNode('value', 'variable', 'unknown', { name: v });
    b.connect(taskId, id, 'uses');
  }

  return b;
}
