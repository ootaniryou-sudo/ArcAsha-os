/**
 * Coding Attachment（H3）— ソフトウェアエンジニアリングモード
 *
 *   CodingAttachment → code.execute → Harness → NativeHarness / DeepSeekHarnessAdapter
 *
 * 実行基盤（コード生成）は Harness に委譲する。ただし Harness の completed は必ずしも
 * コンパイル検証済みではない（DSH は LLM 出力で構文エラーを含みうる）。
 * 本 Attachment は生成コードを node --check で再検証し、検証失敗は ok:false に変換する。
 * H3 では Capability Resolver を導入せず、code.execute へ直接委譲する。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { estimateTokens } from './attachment.js';
import { codeExecute, CODE_EXECUTE } from '../harness/capability.js';
import type { Harness } from '../harness/harness.js';
import { resolveHarness } from '../harness/registry.js';
import { HarnessInfrastructureError } from '../harness/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * 生成コードを node --check で実コンパイル検証する（検証後は一時ファイルを削除）。
 * Harness の completed をそのまま成功と見なさず、必ずこの検証を通す。
 */
async function verifyCode(code: string): Promise<{ ok: boolean; output: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'arcasha-verify-'));
  const file = join(tmpDir, 'generated.mjs');
  try {
    await writeFile(file, code, 'utf-8');
    await execFileAsync(process.execPath, ['--check', file], { timeout: 15000 });
    return { ok: true, output: 'syntax OK' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, output: (err.stderr ?? err.message ?? String(e)).slice(0, 300) };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

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

  // Harness は遅延解決 + メモ化（既定: DSH 不可なら Native へフォールバックを 1 回だけ実施）
  private harnessPromise: Promise<Harness> | null = null;

  /** @param harnessFactory テスト用に Harness を差し替え可能（既定: resolveHarness('deepseek')）。 */
  constructor(
    private readonly harnessFactory: () => Promise<Harness> = () => resolveHarness('deepseek'),
  ) {}

  private harness(): Promise<Harness> {
    this.harnessPromise ??= this.harnessFactory();
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
      // 検証: Harness の completed はコンパイル検証済みを意味しない（DSH は LLM 出力）。
      // node --check で実コンパイル検証し、失敗は ok:false に変換する。
      let verified: { ok: boolean; output: string };
      if (code.trim() === '') {
        verified = { ok: false, output: '出力が空' };
      } else {
        verified = await verifyCode(code);
      }
      detail.push(verified.ok ? 'VERIFY: 成功（node --check）' : `VERIFY: 失敗（${verified.output.slice(0, 60)}）`);

      const ok = result.ok && verified.ok;
      const quality = ok ? 0.9 : 0.5;
      const calls = result.events.filter((e) => e.type === 'started').length;
      const tokens = estimateTokens(code);
      return {
        ok,
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
