/**
 * Chat 記録 — 会話ログを時系列で専用ファイルに自動保存する
 *
 * 目的: ArcAsha Assistant のチャット記録を、長期記憶（スレッド）とは別に
 * 「時系列のログ」として専用ファイルへ追記保存する。会話の全文・モデル・
 * モード・タイムスタンプを後から追跡・参照できるようにする。
 *
 * 保存先: ~/.arcasha/chat-log.jsonl（append-only・git 外）
 * 各エントリ: { ts, threadId, role, content, model, mode, usage }
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** チャットログの役割。 */
export type ChatLogRole = 'user' | 'assistant' | 'system';

/** チャットログエントリ。 */
export interface ChatLogEntry {
  /** タイムスタンプ（ISO）。 */
  ts: string;
  /** スレッド ID。 */
  threadId?: string;
  /** 発言者（user / assistant / system）。 */
  role: ChatLogRole;
  /** メッセージ本文。 */
  content: string;
  /** 使用モデル（assistant 応答時）。 */
  model?: string;
  /** モード（casual / expert）。 */
  mode?: string;
  /** 応答の種別（chat / agent / command）。 */
  kind?: string;
  /** トークン使用量。 */
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  /** 追加メタデータ。 */
  meta?: Record<string, unknown>;
}

/** チャットログストア。 */
export interface ChatLogStore {
  /** 会話 1 件を追記保存する。 */
  append(entry: Omit<ChatLogEntry, 'ts'>): Promise<ChatLogEntry>;
  /** 保存先ファイルパス。 */
  file(): string;
  /** 全ログを読む（read-only・参照用）。 */
  all(): Promise<ChatLogEntry[]>;
  /** ログ件数。 */
  count(): Promise<number>;
}

/** 既定の保存ディレクトリ（.arcasha）。 */
export function defaultChatLogDir(): string {
  return process.env.ARCASHA_CHAT_LOG_DIR ?? path.join(os.homedir(), '.arcasha');
}

/** チャットログストアを生成する（append-only JSONL）。 */
export function createChatLog(dir = defaultChatLogDir()): ChatLogStore {
  const file = path.join(dir, 'chat-log.jsonl');
  let writeChain: Promise<void> = Promise.resolve();

  return {
    file: () => file,
    async append(entry: Omit<ChatLogEntry, 'ts'>): Promise<ChatLogEntry> {
      const full: ChatLogEntry = { ...entry, ts: new Date().toISOString() };
      const json = JSON.stringify(full);
      writeChain = writeChain.then(async () => {
        try {
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          await fs.appendFile(file, json + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch (e) {
          // ログ保存失敗はチャットを止めない（コンソールに出すだけ）
          console.error(`⚠️ チャットログ保存失敗: ${String(e).slice(0, 160)}`);
        }
      });
      await writeChain;
      return full;
    },
    async all(): Promise<ChatLogEntry[]> {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as ChatLogEntry);
      } catch {
        return [];
      }
    },
    async count(): Promise<number> {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.split('\n').filter((l) => l.trim() !== '').length;
      } catch {
        return 0;
      }
    },
  };
}
