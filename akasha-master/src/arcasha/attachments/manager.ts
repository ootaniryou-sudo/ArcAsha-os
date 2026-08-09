/**
 * Attachment Manager（Phase 3.0）— プラグインの登録・遅延ロード・実行
 *
 *   - register() / unregister(): ローダーの登録・解除（遅延ロード）
 *   - load() / unload(): 実体の生成・破棄（Linux の insmod / rmmod 相当）
 *   - enable() / disable(): 有効・無効
 *   - execute() / executeParallel(): 実行（並列実行 + マージ）
 *
 *   Executive は AttachmentManager を通して参加する Attachment を選択する。
 *   Attachment は Kernel 状態を直接変更しない（context 経由でのみ実行）。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { mergeResults } from './attachment.js';
import type { AttachmentMonitor } from './observability.js';

type AttachmentLoader = () => Promise<Attachment>;

export class AttachmentManager {
  private readonly loaders = new Map<string, AttachmentLoader>();
  private readonly loaded = new Map<string, Attachment>();
  private readonly monitor: AttachmentMonitor | null;

  constructor(monitor?: AttachmentMonitor) {
    this.monitor = monitor ?? null;
  }

  /** ローダー登録（遅延ロード: 実体は load まで作らない） */
  register(id: string, loader: AttachmentLoader): void {
    this.loaders.set(id, loader);
  }

  unregister(id: string): void {
    this.loaders.delete(id);
    this.loaded.delete(id);
  }

  isRegistered(id: string): boolean {
    return this.loaders.has(id);
  }

  /** 遅延ロードして実体を生成 */
  async load(id: string): Promise<Attachment> {
    const existing = this.loaded.get(id);
    if (existing) return existing;
    const loader = this.loaders.get(id);
    if (!loader) throw new Error(`AttachmentManager: ${id} は未登録`);
    const a = await loader();
    this.loaded.set(id, a);
    return a;
  }

  unload(id: string): void {
    this.loaded.delete(id);
  }

  async enable(id: string): Promise<void> {
    const a = await this.load(id);
    a.enabled = true;
  }

  async disable(id: string): Promise<void> {
    const a = await this.load(id);
    a.enabled = false;
  }

  get(id: string): Attachment | undefined {
    return this.loaded.get(id);
  }

  /** ロード済み Attachment 一覧 */
  list(): Attachment[] {
    return [...this.loaded.values()];
  }

  /** ロード済みかつ enabled かつ supports を満たす Attachment */
  async available(taskText: string): Promise<Attachment[]> {
    const out: Attachment[] = [];
    for (const id of this.loaders.keys()) {
      if (this.loaded.has(id)) {
        const a = this.loaded.get(id)!;
        if (a.enabled && a.supports(taskText)) out.push(a);
      }
    }
    return out;
  }

  /** 実行（1 つ） */
  async execute(id: string, ctx: AttachmentContext): Promise<AttachmentResult> {
    if (typeof id !== 'string' || id === '') {
      throw new Error('AttachmentManager: id は非空文字列が必要');
    }
    const a = await this.load(id);
    const r = await a.run(ctx);
    this.monitor?.record({ id, name: a.name, latencyMs: r.latencyMs, quality: r.quality, cost: a.estimatedCost, calls: r.calls, tokens: r.tokens });
    return r;
  }

  /** 並列実行（複数 Attachment を同時に走らせ、結果を統合。空配列は空結果） */
  async executeParallel(ids: string[], ctx: AttachmentContext): Promise<Record<string, AttachmentResult>> {
    if (ids.length === 0) return {};
    const entries = await Promise.all(ids.map(async (id) => [id, await this.execute(id, ctx)] as const));
    return Object.fromEntries(entries);
  }

  /** 並列実行 + 統合 */
  async executeMerged(ids: string[], ctx: AttachmentContext, label = 'attachments'): Promise<AttachmentResult> {
    const results = await this.executeParallel(ids, ctx);
    return mergeResults(label, ids.map((id) => results[id]));
  }
}
