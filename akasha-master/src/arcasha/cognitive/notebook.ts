/**
 * Caravan Notebook（Phase A）— Shared Task State / Single Source of Truth
 *
 * 「キャラバンが一つのノートにメモをまとめながらタスクを完成させる」ための
 * 共有作業状態。これは単なる共有メモリ（ログ）ではなく、
 * **Caravan の作業状態そのもの**（Single Source of Truth for Task State）である。
 *
 * 設計契約:
 *   1. Notebook 外にタスク状態を持つ新規実装を作らない。
 *      PLAN / EXECUTE / OBSERVE / VERIFY / REPLAN の全状態遷移は必ず Notebook 経由。
 *   2. 会話ログを入れない。「会話の結果として確定した状態」だけを書く。
 *   3. snapshot() は immutable な versioned state（v0 → v1 → v2 ...）。
 *      思考・作業状態の変遷を残し、「なぜこの結論に到達したか」を後から再生できる
 *      （Decision Explanation / Decision Replay と接続）。
 *   4. Expert は readSections / writeSections の契約で「必要な部分だけ」を読み書きする
 *      （Need-to-know。小さいモデルでも現実的なコンテキスト量になる）。
 *   5. 全エントリは型付き IR 値として保存する（自然言語の代替ではなく、
 *      「Caravan の共同作業状態を操作する言語」としての IR）。
 *
 * セクション構造:
 *   TASK / CONTEXT(known_facts, constraints, resources) / HYPOTHESES / PLAN /
 *   ANALYSIS / EVIDENCE / DECISIONS / OPEN_QUESTIONS / ERRORS / FINAL_DIAGNOSIS
 */

import type { PoolExpert } from './pool.js';

/** Notebook のセクション種別 */
export type NotebookSection =
  | 'task'
  | 'context'
  | 'hypotheses'
  | 'plan'
  | 'analysis'
  | 'evidence'
  | 'decisions'
  | 'open-questions'
  | 'errors'
  | 'final-diagnosis';

export const NOTEBOOK_SECTIONS: readonly NotebookSection[] = [
  'task', 'context', 'hypotheses', 'plan', 'analysis',
  'evidence', 'decisions', 'open-questions', 'errors', 'final-diagnosis',
] as const;

/** Notebook の 1 エントリ（型付き IR 値） */
export interface NotebookEntry {
  id: number;
  section: NotebookSection;
  key: string; // IR データ型（objective / constraint / hypothesis / plan / analysis / simulation / decision / question / error / diagnosis ...）
  value: string; // IR 値: `key: [ ... ]` 形式（AILSM IR と同じ型付きデータ規約）
  by: string; // 書いた Expert
  round: number; // Caravan Loop の Round（0 = 初期化）
  at: number;
  /** critique 元エントリ（OPEN_QUESTIONS / ERRORS が他 Expert の記述を参照する場合） */
  refId?: number;
}

/** immutable なバージョン付きスナップショット */
export interface NotebookSnapshot {
  version: number;
  at: number;
  task: string;
  entries: ReadonlyArray<Readonly<NotebookEntry>>;
}

/** Expert の Notebook I/O 契約（部分供給 = Need-to-know） */
export interface NotebookExpert {
  id: string;
  name: string;
  role: string;
  /** 読めるセクション（Scheduler はここで指定された部分だけを供給する） */
  readSections: readonly NotebookSection[];
  /** 書けるセクション（契約外セクションへの書き込みは拒否される） */
  writeSections: readonly NotebookSection[];
  /**
   * 実モデル / API / 実機での実行（任意）。未指定なら決定論 Simulation。
   * view には readSections のエントリだけが渡る（Notebook 全体は見せない）。
   */
  execute?: (opts: { task: string; round: number; view: ReadonlyArray<Readonly<NotebookEntry>> }) =>
    Promise<{ ir: string; ms: number; ok: boolean }>;
}

/** 型付き IR 値の決定論検証（Notebook レベルの構造契約） */
export function validateIrValue(key: string, value: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
    throw new Error(`Notebook: 不正な IR キー "${key}"（小文字英数字とハイフンのみ）`);
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Notebook: ${key} の値が空です`);
  }
  const m = /^([a-z][a-z0-9_-]*)\s*:\s*(.+)$/s.exec(value);
  if (!m || m[1] !== key) {
    throw new Error(`Notebook: IR 値は "${key}: ..." 形式が必要（実際: "${value.slice(0, 40)}"）`);
  }
}

function freezeEntry(e: NotebookEntry): Readonly<NotebookEntry> {
  return Object.freeze({ ...e });
}

/**
 * Caravan Notebook — Single Source of Truth for Task State
 *
 * 全ての変更は append / critique / fail / diagnose を経由し、
 * 変更ごとに immutable スナップショット（v0, v1, ...）が積み上がる。
 */
export class CaravanNotebook {
  private entries: NotebookEntry[] = [];
  private snapshots: NotebookSnapshot[] = [];
  private nextId = 1;
  /** Notebook の作成時刻（Decision Replay の起点）。 */
  readonly createdAt = Date.now();

  constructor(public readonly task: string) {
    // v0: TASK セクションに objective を書く（Notebook の起点）
    this.append('task', 'objective', `objective: "${task}"`, 'master', { round: 0 });
  }

  /** エントリを追記し、新しいバージョンのスナップショットを作る */
  append(
    section: NotebookSection,
    key: string,
    value: string,
    by: string,
    opts: { round?: number; refId?: number; writer?: NotebookExpert } = {},
  ): NotebookEntry {
    if (!NOTEBOOK_SECTIONS.includes(section)) {
      throw new Error(`Notebook: 不明なセクション "${section}"`);
    }
    // 書き込み権限チェック（writer が指定された場合のみ。master / 内部初期化は無制限）
    const writer = opts.writer;
    if (writer && !writer.writeSections.includes(section)) {
      throw new Error(`Notebook: ${writer.id} はセクション "${section}" に書けない（writeSections 契約違反）`);
    }
    validateIrValue(key, value);
    const e: NotebookEntry = {
      id: this.nextId++,
      section,
      key,
      value,
      by,
      round: opts.round ?? 0,
      at: Date.now(),
      ...(opts.refId !== undefined ? { refId: opts.refId } : {}),
    };
    this.entries.push(e);
    this.pushSnapshot();
    return e;
  }

  /** 他 Expert の記述への批判（OPEN_QUESTIONS に記録。会話ログではなく「確定した懸念」だけ） */
  critique(by: string, targetId: number, question: string, opts: { round?: number; writer?: NotebookExpert } = {}): NotebookEntry {
    const target = this.entries.find((e) => e.id === targetId);
    if (!target) throw new Error(`Notebook: 参照先エントリ #${targetId} が存在しない`);
    return this.append('open-questions', 'question', `question: "${question}" <- #${targetId}`, by, {
      round: opts.round ?? 0,
      refId: targetId,
      writer: opts.writer,
    });
  }

  /** 検証失敗などのエラー記録（ERRORS。REPLAN の入力になる） */
  fail(by: string, message: string, opts: { round?: number; refId?: number; writer?: NotebookExpert } = {}): NotebookEntry {
    return this.append('errors', 'error', `error: "${message}"`, by, {
      round: opts.round ?? 0,
      ...(opts.refId !== undefined ? { refId: opts.refId } : {}),
      writer: opts.writer,
    });
  }

  /** 最終診断（FINAL_DIAGNOSIS。result / confidence / limitations） */
  diagnose(
    by: string,
    result: string,
    confidence: number,
    limitations: string[],
    opts: { round?: number; writer?: NotebookExpert } = {},
  ): NotebookEntry {
    const c = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0));
    return this.append(
      'final-diagnosis',
      'diagnosis',
      `diagnosis: [result="${result}", conf=${Math.round(c * 100)}%, limitations=[${limitations.join('; ')}]]`,
      by,
      { round: opts.round ?? 0, writer: opts.writer },
    );
  }

  /** Need-to-know 読み取り: 指定セクションのエントリだけを返す */
  read(sections: readonly NotebookSection[]): ReadonlyArray<Readonly<NotebookEntry>> {
    return this.entries.filter((e) => sections.includes(e.section)).map(freezeEntry);
  }

  /** Expert への部分供給（readSections 契約に基づく view） */
  view(expert: NotebookExpert): ReadonlyArray<Readonly<NotebookEntry>> {
    return this.read(expert.readSections);
  }

  /** 指定 key の最新値（例: 最新の plan / 最新の simulation 結果） */
  latest(key: string): Readonly<NotebookEntry> | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].key === key) return freezeEntry(this.entries[i]);
    }
    return undefined;
  }

  entriesOf(section: NotebookSection): ReadonlyArray<Readonly<NotebookEntry>> {
    return this.entries.filter((e) => e.section === section).map(freezeEntry);
  }

  get size(): number {
    return this.entries.length;
  }

  /** 現在のバージョン（スナップショット数 - 1 = vN の N） */
  get version(): number {
    return this.snapshots.length - 1;
  }

  /** immutable スナップショットを取得（指定なし = 最新版） */
  snapshot(version?: number): NotebookSnapshot {
    if (version === undefined) return this.snapshots[this.snapshots.length - 1];
    const s = this.snapshots[version];
    if (!s) throw new Error(`Notebook: バージョン v${version} は存在しない（0〜${this.version}）`);
    return s;
  }

  /** 全バージョンの履歴（Decision Replay の材料） */
  history(): ReadonlyArray<NotebookSnapshot> {
    return [...this.snapshots];
  }

  /** Notebook のテキスト描画（CLI / Replay 用） */
  render(maxEntriesPerSection = 4): string {
    const lines: string[] = [`CARAVAN_NOTEBOOK v${this.version} — "${this.task}"`];
    for (const s of NOTEBOOK_SECTIONS) {
      const es = this.entriesOf(s);
      if (es.length === 0) continue;
      lines.push(`${s.toUpperCase()} (${es.length})`);
      for (const e of es.slice(-maxEntriesPerSection)) {
        lines.push(`  [#${e.id}] (${e.by} r${e.round}) ${e.value}`);
      }
    }
    return lines.join('\n');
  }

  private pushSnapshot(): void {
    this.snapshots.push({
      version: this.snapshots.length,
      at: Date.now(),
      task: this.task,
      entries: Object.freeze(this.entries.map(freezeEntry)),
    });
  }
}

/** PoolExpert を Notebook I/O 契約付き Expert に変換する（Phase C 接続口） */
export function notebookExpertFromPool(
  p: PoolExpert,
  io: { readSections: readonly NotebookSection[]; writeSections: readonly NotebookSection[] },
): NotebookExpert {
  const exec = p.execute;
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    readSections: io.readSections,
    writeSections: io.writeSections,
    ...(exec
      ? {
          execute: async (opts) => {
            const input = opts.view.length > 0 ? { key: opts.view[opts.view.length - 1].key, value: opts.view[opts.view.length - 1].value } : undefined;
            const r = await exec({ task: opts.task, input });
            return { ir: r.ir, ms: r.ms, ok: r.ok };
          },
        }
      : {}),
  };
}