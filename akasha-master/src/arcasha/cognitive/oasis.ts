/**
 * Knowledge Oasis — 長期記憶（Task / Reasoning / Team / Policy / Lesson）
 *
 * 「砂漠を旅するキャラバンがオアシスを作る」比喩の実装:
 * タスク完了ごとに、その経験（タスク・チーム・配線・仮説・結果・教訓）を
 * IR だけで保存し、次のキャラバン（チーム）が参照できるようにする。
 *
 * 蓄積されるのは LLM の重みではなく「OS レベルの運用知識」:
 *   - どんなチーム編成が成功したか（Team / Policy Archive）
 *   - どんな推論経路が成功したか（Reasoning Archive）
 *   - どんな Lesson が得られたか（Lesson Archive）
 *
 * 権限（Need-to-know）:
 *   Master     : 全部読める
 *   Caravan    : Task / Reasoning / Policy
 *   Expert     : Task / Reasoning だけ
 *   Attachment : 必要部分だけ
 */

import type { NotebookSnapshot } from './notebook.js';

export type OasisRole = 'master' | 'caravan' | 'expert' | 'attachment';

export interface OasisEntry {
  task: string;          // Task Archive（何をやったか）
  team: string[];        // Team Archive（誰がやったか）
  graph: string[];       // Reasoning Archive（どう配線したか）
  hypothesis: string[];  // Reasoning Archive（どう考えたか: 仮説）
  result: 'success' | 'fail';
  quality: number;
  lesson: string;        // Lesson Archive（何を学んだか）
  confidence: number;
  at: number;
  /** Caravan: 完成 Notebook の immutable snapshot（Decision Replay の材料） */
  notebookSnapshot?: NotebookSnapshot;
  /** Caravan: 最終計画（IR） */
  plan?: string;
  /** Caravan: 最終診断（IR） */
  diagnosis?: string;
}

/** Caravan 完了記録（KnowledgeOasis.recordCaravan の入力） */
export interface CaravanOasisRecord {
  task: string;
  team: string[];
  result: 'success' | 'fail';
  quality: number;
  lesson: string;
  confidence: number;
  notebookSnapshot: NotebookSnapshot;
  plan?: string;
  diagnosis?: string;
  at?: number;
}

export class KnowledgeOasis {
  private entries: OasisEntry[] = [];
  private readonly capacity = 1000;

  /** 経験を保存（オアシスに記録） */
  record(e: OasisEntry): void {
    this.entries.unshift(e);
    if (this.entries.length > this.capacity) this.entries.pop();
  }

  /**
   * Caravan の完了を記録する（完成 Notebook snapshot + Team + Plan + 最終診断）。
   * 次回の Caravan がチーム編成・計画の参考にする（Runtime Knowledge Base）。
   */
  recordCaravan(rec: CaravanOasisRecord): OasisEntry {
    const e: OasisEntry = {
      task: rec.task,
      team: rec.team,
      graph: [],
      hypothesis: [`H1: team[${rec.team.join('>')}] で実行`, `H2: Notebook を Single Source of Truth に`],
      result: rec.result,
      quality: rec.quality,
      lesson: rec.lesson,
      confidence: rec.confidence,
      at: rec.at ?? Date.now(),
      notebookSnapshot: rec.notebookSnapshot,
      ...(rec.plan !== undefined ? { plan: rec.plan } : {}),
      ...(rec.diagnosis !== undefined ? { diagnosis: rec.diagnosis } : {}),
    };
    this.record(e);
    return e;
  }

  /** 類似タスク検索（キーワード一致。Runtime Knowledge Base） */
  search(query: string): OasisEntry[] {
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter((w) => w.length > 1);
    return this.entries.filter(
      (e) => e.task.toLowerCase().includes(q) || words.some((w) => e.task.toLowerCase().includes(w)),
    );
  }

  /** 成功率・品質の高い順に推奨（Caravan が新しいタスクのチームを組む参考にする） */
  recommend(query: string): OasisEntry[] {
    return this.search(query).sort((a, b) => {
      const sa = a.result === 'success' ? 1 : 0;
      const sb = b.result === 'success' ? 1 : 0;
      return sb - sa || b.quality - a.quality;
    });
  }

  /** Lesson Archive — 今回何を学んだかのみの一覧 */
  lessons(): string[] {
    return this.entries.filter((e) => e.lesson.length > 0).map((e) => e.lesson);
  }

  /** 権限に応じて見える範囲を制限する（Need-to-know） */
  view(role: OasisRole, e: OasisEntry): Partial<OasisEntry> {
    switch (role) {
      case 'master':
        return { ...e };
      case 'caravan':
        // Task / Reasoning / Policy / Plan / 診断
        return { task: e.task, team: e.team, graph: e.graph, hypothesis: e.hypothesis, result: e.result, quality: e.quality, lesson: e.lesson, confidence: e.confidence, plan: e.plan, diagnosis: e.diagnosis };
      case 'expert':
        // Task / Reasoning だけ
        return { task: e.task, hypothesis: e.hypothesis, result: e.result };
      case 'attachment':
      default:
        // 必要部分だけ
        return { task: e.task };
    }
  }

  all(): OasisEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }
}

/** IR 形式の Lesson を組み立てる */
export function makeLesson(task: string, team: string[], success: boolean, quality: number, extra = ''): string {
  const prefix = success ? `LESSON: ${task} → team[${team.join(', ')}] success` : `LESSON: ${task} → team[${team.join(', ')}] fail`;
  const q = ` quality=${Math.round(quality * 100)}%`;
  return `${prefix}${q}${extra ? ` ${extra}` : ''}`;
}

/** Oasis の表示（Knowledge Base 風） */
export function renderOasis(o: KnowledgeOasis, role: OasisRole = 'master'): string {
  if (o.size === 0) return '（オアシスはまだ空です）';
  const lines: string[] = [];
  lines.push(`Oasis: ${o.size} 件の経験（権限: ${role}）`);
  for (const e of o.all().slice(0, 8)) {
    const v = o.view(role, e);
    const parts: string[] = [];
    if (v.task) parts.push(`task: ${v.task}`);
    if (v.team) parts.push(`team: [${v.team.join('>')}]`);
    if (v.graph) parts.push(`graph: ${v.graph.join(' , ')}`);
    if (v.hypothesis) parts.push(`hypo: ${v.hypothesis.join(' | ')}`);
    if (v.result) parts.push(`result: ${v.result}`);
    if (v.quality !== undefined) parts.push(`q: ${(v.quality * 100).toFixed(0)}%`);
    if (v.lesson) parts.push(`lesson: ${v.lesson}`);
    if (v.plan) parts.push(`plan: ${v.plan.slice(0, 48)}`);
    if (v.diagnosis) parts.push(`diag: ${v.diagnosis.slice(0, 48)}`);
    if (v.notebookSnapshot) parts.push(`snap: v${v.notebookSnapshot.version} (entries=${v.notebookSnapshot.entries.length})`);
    lines.push(`  ${parts.join('  ')}`);
  }
  return lines.join('\n');
}
