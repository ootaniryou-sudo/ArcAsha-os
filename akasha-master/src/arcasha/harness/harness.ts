/**
 * Coding Harness — Harness インターフェース（Ports & Adapters の Port）
 *
 * Coding Attachment は特定の Agent Runtime（DeepSeek Harness 等）を知らない。
 * 依存方向は常に:
 *
 *   CodingAttachment → Harness interface ← DeepSeekHarnessAdapter
 *
 * 失敗の意味論:
 *   - failed イベント = Task failure（Harness は存続可能）
 *   - iterator throw  = Harness / Adapter の継続不能障害（infrastructure failure）
 *   - cancel           ≠ failed
 *   - detach           ≠ rollback
 */
import type { HarnessTask, HarnessExecuteOptions } from './types.js';
import type { HarnessEvent } from './events.js';

export interface Harness {
  /**
   * タスクを実行し、Event Stream として逐次観測できるようにする。
   * Promise<Result> を基本 API にしない。
   */
  execute(
    task: HarnessTask,
    options?: HarnessExecuteOptions,
  ): AsyncIterable<HarnessEvent>;
}
