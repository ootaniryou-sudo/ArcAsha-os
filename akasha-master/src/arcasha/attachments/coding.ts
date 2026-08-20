/**
 * Coding Attachment（H3）— ソフトウェアエンジニアリングモード
 *
 *   CodingAttachment → code.execute → Harness → NativeHarness / DeepSeekHarnessAdapter
 *
 * 実行基盤（コード生成・自己レビュー・実コンパイル）は Harness に委譲する。
 * H3 では Capability Resolver を導入せず、code.execute へ直接委譲する。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { estimateTokens } from './attachment.js';
import { codeExecute, CODE_EXECUTE } from '../harness/capability.js';
import type { Harness } from '../harness/harness.js';
import { resolveHarness } from '../harness/registry.js';
import { HarnessInfrastructureError } from '../harness/types.js';

/** タスク文から安定した taskId を生成（決定論。同一タスクは同一 taskId）。 */
function hashTaskId(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `coding-${(h >>> 0).toString(16)}`;
}

export class CodingAttachment implements Attachment {
  readonly id = 'coding';
  readonly name = 'Coding';
  readonly version = '3.0.0'; // H3: Harness 委譲（code.execute）
  enabled = true;
  estimatedCost = 0.5;
  estimatedLatency = 500;
  estimatedAccuracy = 0.9;

  /** 宣言する Capability（H3 §23）。 */
  capabilities: readonly string[] = [CODE_EXECUTE];

  // Harness は遅延解決 + メモ化（DSH 不可なら Native へフォールバックを 1 回だけ実施）
  private harnessPromise: Promise<Harness> | null = null;

  private harness(): Promise<Harness> {
    this.harnessPromise ??= resolveHarness('deepseek');
    return this.harnessPromise;
  }

  supports(text: string): boolean {
    return /実装|コード|バグ|修正|programming|coding|作って|関数|リファクタ/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const detail: string[] = [];
    const startedAt = Date.now();
    detail.push(`CAPABILITY: ${CODE_EXECUTE}`);

    try {
      const harness = await this.harness();
      const result = await codeExecute(
        { taskId: hashTaskId(ctx.text), text: ctx.text },
        { harness },
      );

      // 観測イベント → パイプラインログ（progress 観測）
      detail.push(`HARNESS: ${result.harnessKind}（executionId=${result.executionId ?? '-'} / ${result.latencyMs.toFixed(0)}ms）`);
      for (const e of result.events) {
        if (e.type === 'message') detail.push(`EVENT(message): ${e.text}`);
        if (e.type === 'completed') detail.push(`EVENT(completed): ok=${e.result.ok}`);
        if (e.type === 'failed') detail.push(`EVENT(failed): ${e.error.code}`);
        if (e.type === 'cancelled') detail.push(`EVENT(cancelled): ${e.reason}`);
      }

      const code = result.output;
      const quality = result.ok ? 0.9 : 0.5;
      const calls = result.events.filter((e) => e.type === 'started').length;
      const tokens = estimateTokens(code);
      return {
        ok: result.ok,
        text: code,
        quality,
        latencyMs: result.latencyMs,
        calls,
        tokens,
        detail,
      };
    } catch (e) {
      if (e instanceof HarnessInfrastructureError) {
        // infra failure は Attachment としては失敗（ok=false）に丸める
        detail.push(`INFRA: ${e.message}`);
        return {
          ok: false,
          text: '',
          quality: 0,
          latencyMs: Date.now() - startedAt,
          calls: 0,
          tokens: 0,
          detail,
        };
      }
      throw e;
    }
  }
}
