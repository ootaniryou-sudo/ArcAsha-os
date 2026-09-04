/**
 * ArcAsha Assistant — 長期記憶層（Hermes Agent 風）
 *
 * 一般ユーザー向け AI アシスタントの「永続的な記憶」を提供する。
 * - スレッド（会話履歴）: タイトル付きで複数保存・再開できる
 * - ユーザー記憶（facts）: 「私の名前は〜」「〜が好き」等、ユーザーについての記憶
 * - 知識（knowledge）: ユーザーが教えた事実・好み・タスク手順
 * - エピソード要約: 会話の要点を自動蓄積（コンテキスト削減用）
 *
 * 保存先: 既定は ~/.arcasha/assistant-memory.json（env ARCASHA_MEMORY_DIR で変更可）。
 * JSON 1 ファイルに永続化するため、サーバ再起動後も記憶が残る。依存ゼロ。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface StoredMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 回答に使ったモデル / モード（任意） */
  meta?: {
    model?: string;
    mode?: string;
    ms?: number;
    /** AILSM コンパイル結果（Chat 内で AILSM 出力を表示するため） */
    ailsm?: unknown;
  };
  ts: string;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  /** モード: casual（一般）| expert（上級） */
  mode: 'casual' | 'expert';
  pinned?: boolean;
}

export interface Fact {
  id: string;
  /** 内容（自然文） */
  text: string;
  /** カテゴリ（user / preference / task / other） */
  category: string;
  ts: string;
  /** 直近に言及された会話 id（任意） */
  sourceThreadId?: string;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  text: string;
  ts: string;
}

export interface MemorySnapshot {
  threads: Thread[];
  facts: Fact[];
  knowledge: KnowledgeEntry[];
  path: string;
}

/** 記憶ディレクトリ（デフォルト: ~/.arcasha） */
export function defaultMemoryDir(): string {
  return process.env.ARCASHA_MEMORY_DIR || path.join(os.homedir(), '.arcasha');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 軽量 ID */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 会話からスレッドタイトルを推定（先頭ユーザー文から） */
export function guessTitle(messages: { role: string; content: string }[]): string {
  const first = messages.find((m) => m.role === 'user')?.content ?? '';
  const t = first.replace(/\s+/g, ' ').trim();
  return t.length > 28 ? t.slice(0, 28) + '…' : t || '新しい会話';
}

/**
 * 長期記憶マネージャ。JSON ファイルへ自動永続化（書き込みは逐次・直列化）。
 */
export class LongTermMemory {
  private threads: Thread[] = [];
  private facts: Fact[] = [];
  private knowledge: KnowledgeEntry[] = [];
  /** 一時スレッド（永続化しない。OpenAI 互換 API の一時履歴用） */
  private ephemeralIds = new Set<string>();
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(dir = defaultMemoryDir()) {
    this.filePath = path.join(dir, 'assistant-memory.json');
  }

  /** 起動時にファイルから読み込む。ENOENT のみ空で開始し、破損時は .bak へ退避してから空で開始する。 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as Partial<MemorySnapshot>;
      this.threads = Array.isArray(data.threads) ? data.threads : [];
      this.facts = Array.isArray(data.facts) ? data.facts : [];
      this.knowledge = Array.isArray(data.knowledge) ? data.knowledge : [];
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.threads = [];
        this.facts = [];
        this.knowledge = [];
        return;
      }
      // 壊れたファイルで既存の記憶を上書きしないよう、退避してから空で開始する
      console.error(`⚠️ 記憶ファイルが読めないため .bak へ退避して空で開始します: ${String(e).slice(0, 160)}`);
      try {
        await fs.rename(this.filePath, `${this.filePath}.bak`);
      } catch {
        /* 退避に失敗しても続行（読み取り不能なままだと次回も同じエラーになるため、退避失敗時はその旨を記録） */
      }
      this.threads = [];
      this.facts = [];
      this.knowledge = [];
    }
  }

  /** 変更をファイルへ直列化して書く（多重 write を直列化。失敗時は dirty を保持して次回再試行） */
  private scheduleWrite(): void {
    this.dirty = true;
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirty) return;
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(this.snapshot(), null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(tmp, 0o600).catch(() => undefined);
        await fs.rename(tmp, this.filePath);
        this.dirty = false; // 書き込み成功して初めてクリア（失敗時は次回の scheduleWrite で再試行）
      } catch (e) {
        console.error(`⚠️ 記憶の保存に失敗（再試行します）: ${String(e).slice(0, 120)}`);
      }
    });
  }

  // ─── Threads ───────────────────────────────────────────────────
  listThreads(): Thread[] {
    return [...this.threads].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  getThread(id: string): Thread | undefined {
    return this.threads.find((t) => t.id === id);
  }

  /** 新規スレッド作成（既存 id 指定で復元も可能。ephemeral=true は永続化しない一時スレッド） */
  createThread(opts: { title?: string; mode?: 'casual' | 'expert'; messages?: StoredMessage[]; ephemeral?: boolean } = {}): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: uid(),
      title: opts.title ?? '新しい会話',
      createdAt: now,
      updatedAt: now,
      messages: opts.messages ?? [],
      mode: opts.mode ?? 'casual',
    };
    this.threads.push(thread);
    if (opts.ephemeral === true) this.ephemeralIds.add(thread.id);
    this.scheduleWrite();
    return thread;
  }

  appendMessage(threadId: string, msg: Omit<StoredMessage, 'ts'>): Thread | undefined {
    const t = this.getThread(threadId);
    if (!t) return undefined;
    t.messages.push({ ...msg, ts: new Date().toISOString() });
    t.updatedAt = new Date().toISOString();
    if (t.title === '新しい会話') t.title = guessTitle(t.messages);
    this.scheduleWrite();
    return t;
  }

  renameThread(threadId: string, title: string): boolean {
    const t = this.getThread(threadId);
    if (!t) return false;
    t.title = title.trim().slice(0, 60) || t.title;
    t.updatedAt = new Date().toISOString();
    this.scheduleWrite();
    return true;
  }

  setMode(threadId: string, mode: 'casual' | 'expert'): boolean {
    const t = this.getThread(threadId);
    if (!t) return false;
    t.mode = mode;
    this.scheduleWrite();
    return true;
  }

  togglePinned(threadId: string): boolean {
    const t = this.getThread(threadId);
    if (!t) return false;
    return this.setPinned(threadId, !t.pinned);
  }

  /** ピン留めを設定して永続化する（getThread 経由の直接変更は保存されないためこの mutator を使う） */
  setPinned(threadId: string, pinned: boolean): boolean {
    const t = this.getThread(threadId);
    if (!t) return false;
    t.pinned = pinned;
    this.scheduleWrite();
    return true;
  }

  deleteThread(threadId: string): boolean {
    const i = this.threads.findIndex((t) => t.id === threadId);
    if (i < 0) return false;
    this.threads.splice(i, 1);
    this.scheduleWrite();
    return true;
  }

  /** 会話履歴（直近 N 件まで）を返す。limit<=0 は空（slice(-0) の全件返却を防ぐ） */
  recentMessages(threadId: string, limit = 30): StoredMessage[] {
    if (limit <= 0) return [];
    const t = this.getThread(threadId);
    if (!t) return [];
    return t.messages.slice(-limit);
  }

  // ─── Facts（ユーザー記憶）──────────────────────────────────────
  listFacts(category?: string): Fact[] {
    const list = category ? this.facts.filter((f) => f.category === category) : this.facts;
    return [...list].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  addFact(text: string, category = 'user', sourceThreadId?: string): Fact {
    const fact: Fact = { id: uid(), text: text.trim().slice(0, 500), category, ts: new Date().toISOString(), sourceThreadId };
    this.facts.push(fact);
    this.scheduleWrite();
    return fact;
  }

  deleteFact(id: string): boolean {
    const i = this.facts.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.facts.splice(i, 1);
    this.scheduleWrite();
    return true;
  }

  // ─── Knowledge（教えた知識・手順）──────────────────────────────
  listKnowledge(): KnowledgeEntry[] {
    return [...this.knowledge].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  addKnowledge(title: string, text: string): KnowledgeEntry {
    const entry: KnowledgeEntry = { id: uid(), title: title.trim().slice(0, 100), text: text.trim(), ts: new Date().toISOString() };
    this.knowledge.push(entry);
    this.scheduleWrite();
    return entry;
  }

  deleteKnowledge(id: string): boolean {
    const i = this.knowledge.findIndex((k) => k.id === id);
    if (i < 0) return false;
    this.knowledge.splice(i, 1);
    this.scheduleWrite();
    return true;
  }

  // ─── コンテキスト合成（プロンプト埋め込み用）────────────────────
  /**
   * 会話の回答に使う「記憶コンテキスト」を組み立てる。
   * - 直近スレッドの前文脈（直近 N 件）
   * - ユーザーに関連する facts（キーワード一致で最大 k 件）
   * - knowledge（キーワード一致で最大 k 件）
   * 単語境界でなく部分一致（部分文字列）なので日本語でも雑に効く。
   */
  buildMemoryContext(query: string, threadId?: string, opts: { recent?: number; factMax?: number; knowMax?: number } = {}): string {
    const recent = opts.recent ?? 12;
    const factMax = opts.factMax ?? 6;
    const knowMax = opts.knowMax ?? 4;
    const parts: string[] = [];

    // 1) 現在スレッドの直前の会話（短期）
    if (threadId) {
      const msgs = this.recentMessages(threadId, recent).slice(0, -1); // 最後の user は含めない
      if (msgs.length > 0) {
        parts.push('[直近の会話]');
        for (const m of msgs.slice(-6)) parts.push(`${m.role === 'user' ? 'あなた' : 'アシスタント'}: ${m.content.slice(0, 300)}`);
      }
    }

    // 2) ユーザー記憶（facts）— クエリと部分一致したものを優先
    const q = query.toLowerCase();
    const related = this.facts.filter((f) => q.split(/\s+/).some((w) => w.length >= 2 && f.text.toLowerCase().includes(w)));
    const picks = (related.length > 0 ? related : this.facts.slice(0, factMax)).slice(0, factMax);
    if (picks.length > 0) {
      parts.push('[あなたについての記憶]');
      for (const f of picks) parts.push(`- ${f.text}`);
    }

    // 3) 知識（教えられたこと）
    const knew = this.knowledge.filter((k) => q.split(/\s+/).some((w) => w.length >= 2 && (k.title + ' ' + k.text).toLowerCase().includes(w)));
    const knowPicks = (knew.length > 0 ? knew : this.knowledge.slice(0, knowMax)).slice(0, knowMax);
    if (knowPicks.length > 0) {
      parts.push('[あなたが教えた知識]');
      for (const k of knowPicks) parts.push(`- ${k.title}: ${k.text.slice(0, 400)}`);
    }

    return parts.join('\n');
  }

  snapshot(): MemorySnapshot {
    // ephemeral スレッドは永続化しない（一時スレッドはファイルに残さない）
    const threads = this.threads.filter((t) => !this.ephemeralIds.has(t.id));
    return { threads, facts: this.facts, knowledge: this.knowledge, path: this.filePath };
  }

  memoryPath(): string {
    return this.filePath;
  }

  /** テスト用: ファイルへ同期的に反映を待つ */
  async flush(): Promise<void> {
    await sleep(10);
    await this.writeChain;
  }
}
