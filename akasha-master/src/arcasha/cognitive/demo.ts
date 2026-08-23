/**
 * Cognitive Graph Runtime デモ — Task-Specific Dynamic Cognitive Graph
 *
 * 「モデルを選ぶ」のではなく「タスクごとに知能の配線を生成する」。
 * 1. AI Pool → composeTeam（凸凹=データ型で自動配線）
 * 2. runCognitive（共有メモリ + IR 通信で実行）
 * 3. Team Learning（成功率でチーム編成を学習）
 * 4. Knowledge Oasis（経験を IR で保存 → 次のタスクで推奨）
 *
 * 実行: npx tsx src/arcasha/cognitive/demo.ts
 */

import { AI_POOL } from './pool.js';
import { composeTeam, renderComposition } from './capability-graph.js';
import { runCognitive, renderCognitive } from './runtime.js';
import { TeamLearner, renderTeamLearning } from './team-learning.js';
import { KnowledgeOasis, makeLesson, renderOasis } from './oasis.js';
import { runCaravan, fixedCaravan, renderCaravan } from './caravan-loop.js';

export async function runCognitiveDemo(): Promise<string> {
  const learner = new TeamLearner();
  const oasis = new KnowledgeOasis();
  const lines: string[] = [];

  // 旅（Journey）: 複数タスクを実行して経験を積む
  const tasks = [
    '自律飛行ドローンを設計して',
    'カメラから物体を検出して',
    'ロボットの移動計画を実装して',
    '画像から飛行軌道を計算して',
    'x^2+3x+2=0を解いて',
    'ドローンの衝突回避を実装して',
  ];

  for (const task of tasks) {
    const team = composeTeam(AI_POOL, task);
    const r = await runCognitive(team, task);
    const teamKey = r.team.join('>');
    learner.record(teamKey, r.success, r.quality);
    oasis.record({
      task,
      team: r.team,
      graph: r.graph,
      hypothesis: [`H1: team[${teamKey}] で実行`, `H2: 共有メモリ経由で受け渡し`],
      result: r.success ? 'success' : 'fail',
      quality: r.quality,
      lesson: makeLesson(task, r.team, r.success, r.quality),
      confidence: 0.9,
      at: Date.now(),
    });
  }

  // 1. 編成（凸凹=データ型）
  lines.push('■ タスク「自律飛行ドローンを設計して」→ 自動編成');
  lines.push(renderComposition(composeTeam(AI_POOL, '自律飛行ドローンを設計して')));
  lines.push('');

  // 2. 実行（共有メモリ + IR 通信）
  lines.push(renderCognitive(await runCognitive(composeTeam(AI_POOL, '自律飛行ドローンを設計して'), '自律飛行ドローンを設計して')));
  lines.push('');

  // 3. Team Learning
  lines.push('■ Team Learning（成功率でチーム編成を学習）');
  lines.push(renderTeamLearning(learner));
  lines.push('');

  // 4. Knowledge Oasis（長期記憶）
  lines.push('■ Knowledge Oasis（Master 視点: 全部見える）');
  lines.push(renderOasis(oasis, 'master'));
  lines.push('');
  lines.push('■ 権限（Need-to-know）: Caravan 視点（Task / Reasoning / Policy）');
  lines.push(renderOasis(oasis, 'caravan'));
  lines.push('');
  lines.push('■ 新タスク「画像認識ドローン」→ Oasis から類似経験を推奨（Runtime Knowledge Base）');
  const recs = oasis.recommend('ドローン');
  for (const rec of recs.slice(0, 3)) {
    lines.push(`  → ${rec.task}（team [${rec.team.join('>')}] · ${rec.result} · q=${(rec.quality * 100).toFixed(0)}%）`);
  }
  if (recs.length > 0) {
    const top = recs[0];
    const recTeam = composeTeam(AI_POOL, top.task);
    lines.push(`  推奨チーム: ${recTeam.members.map((m) => m.name).join(' → ')}`);
    lines.push(`  （前回の経験を再利用: 一から考えなくて済む = オアシス）`);
  }

  return lines.join('\n');
}

/**
 * Caravan Loop デモ — Notebook を Single Source of Truth にしたタスク実行組織
 *
 * 1. 固定 Caravan（planning + ドメイン Expert）を編成
 * 2. runCaravan: PLAN → EXECUTE → OBSERVE → VERIFY → (PASS: DIAGNOSIS | FAIL: REPLAN)
 * 3. 完了 Notebook snapshot を Oasis へ保存 → 次回の推奨材料に
 *
 * 実行: npx tsx src/arcasha/cognitive/demo.ts --caravan
 */
export async function runCaravanDemo(): Promise<string> {
  const oasis = new KnowledgeOasis();
  const learner = new TeamLearner();
  const lines: string[] = [];

  const tasks = [
    '自律飛行ドローンの制御コードを実装して',
    'x^2+3x+2=0を解いて',
    'ドローンの衝突回避コードを再試行して', // failFirst → REPLAN → PASS
  ];

  for (const task of tasks) {
    const team = fixedCaravan(task);
    const r = await runCaravan({ task, team, oasis, learner });
    lines.push(renderCaravan(r));
    lines.push('');
  }

  lines.push('■ Team Learning（チーム編成の成功率を学習）');
  lines.push(renderTeamLearning(learner));
  lines.push('');

  lines.push('■ Knowledge Oasis（Caravan 完了記録 + 完成 Notebook snapshot）');
  lines.push(renderOasis(oasis, 'master'));
  lines.push('');

  lines.push('■ Oasis から類似経験を推奨（Runtime Knowledge Base）');
  const recs = oasis.recommend('ドローン');
  for (const rec of recs.slice(0, 3)) {
    const snap = rec.notebookSnapshot ? ` / snap=v${rec.notebookSnapshot.version}` : '';
    lines.push(`  → ${rec.task}（team [${rec.team.join('>')}] · ${rec.result} · q=${(rec.quality * 100).toFixed(0)}%${snap}）`);
  }

  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // --caravan で Caravan Loop デモ、既定は Cognitive Graph デモ
  const run = process.argv.includes('--caravan') ? runCaravanDemo() : runCognitiveDemo();
  run.then((s) => console.log(s)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

