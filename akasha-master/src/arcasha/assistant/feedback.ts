/**
 * フィードバック保存 — ユーザーの 👍/👎 評価と理由を保存し、AI の最適化に使う
 *
 * 目的: ユーザーへの最適化。各応答について「どうして👍を押したか / 👎を押したか」
 * を理由付きで記録し、後から AI（エージェント）が学習・改善に参照できるようにする。
 *
 * 保存先: ~/.arcasha/assistant-feedback.jsonl（append-only・git 外）
 * 各エントリ: { ts, threadId, messageId, rating, reason, model, mode, prompt, response }
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** フィードバック評価。 */
export type FeedbackRating = 'good' | 'bad';

/** フィードバックエントリ。 */
export interface FeedbackEntry {
  /** タイムスタンプ（ISO）。 */
  ts: string;
  /** 対象スレッド ID。 */
  threadId?: string;
  /** 対象メッセージ ID（無い場合は null）。 */
  messageId?: string | null;
  /** 👍 / 👎。 */
  rating: FeedbackRating;
  /** ユーザーが入力した理由（自由記述・任意）。 */
  reason?: string;
  /** 応答に使ったモデル。 */
  model?: string;
  /** モード（casual / expert）。 */
  mode?: string;
  /** ユーザーの質問（学習用）。 */
  prompt?: string;
  /** AI の応答（学習用・長い場合は切り詰め）。 */
  response?: string;
  /** トークン使用量。 */
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  /** 追加メタデータ。 */
  meta?: Record<string, unknown>;
}

/** フィードバックストア。 */
export interface FeedbackStore {
  /** フィードバックを追記保存する。 */
  add(entry: Omit<FeedbackEntry, 'ts'>): Promise<FeedbackEntry>;
  /** 保存先ファイルパス。 */
  file(): string;
  /** 全フィードバックを読む（read-only・学習用）。 */
  all(): Promise<FeedbackEntry[]>;
  /** 統計（good / bad の件数）。 */
  stats(): Promise<{ good: number; bad: number; total: number }>;
}

/** 既定のフィードバック保存ディレクトリ。 */
export function defaultFeedbackDir(): string {
  return process.env.ARCASHA_FEEDBACK_DIR ?? path.join(os.homedir(), '.arcasha');
}

/** フィードバックストアを生成する。 */
export function createFeedbackStore(dir = defaultFeedbackDir()): FeedbackStore {
  const file = path.join(dir, 'assistant-feedback.jsonl');
  let writeChain: Promise<void> = Promise.resolve();

  return {
    file: () => file,
    async add(entry: Omit<FeedbackEntry, 'ts'>): Promise<FeedbackEntry> {
      const full: FeedbackEntry = { ...entry, ts: new Date().toISOString() };
      const json = JSON.stringify(full);
      writeChain = writeChain.then(async () => {
        try {
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          await fs.appendFile(file, json + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch (e) {
          console.error(`⚠️ フィードバック保存失敗: ${String(e).slice(0, 160)}`);
        }
      });
      await writeChain;
      return full;
    },
    async all(): Promise<FeedbackEntry[]> {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as FeedbackEntry);
      } catch {
        return [];
      }
    },
    async stats(): Promise<{ good: number; bad: number; total: number }> {
      const list = await this.all();
      const good = list.filter((e) => e.rating === 'good').length;
      return { good, bad: list.length - good, total: list.length };
    },
  };
}
