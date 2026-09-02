/**
 * SWE-bench instance の型定義とローダ。
 *
 * SWE-bench Lite の 1 instance は以下の情報を持つ（HuggingFace datasets:
 * princeton-nlp/SWE-bench_Lite の行に対応）:
 *   - instance_id   : 'owner__repo-<PR番号>' 形式の一意 ID
 *   - repo          : 'owner/repo'（GitHub リポジトリ）
 *   - base_commit   : 問題を含むベースコミット SHA
 *   - patch         : 解決パッチ（gold / 評価時は agent が生成した diff と比較）
 *   - test_patch    : 評価用テストを追加するパッチ（FAIL_TO_PASS を有効化）
 *   - problem_statement : issue 文（エージェントへ渡す）
 *   - FAIL_TO_PASS  : 解決後に通るべきテスト（解決前は失敗）
 *   - PASS_TO_PASS  : 解決前後で通るべきテスト（回帰防止）
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** SWE-bench Lite の 1 instance。 */
export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  /** 解決パッチ（gold。評価では agent 生成パッチと照合・適用する）。 */
  patch?: string;
  /** テストパッチ（評価時に適用して FAIL_TO_PASS を有効化）。 */
  test_patch?: string;
  problem_statement: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
}

/** instance の読み込み結果。 */
export interface InstanceLoadResult {
  instances: SweBenchInstance[];
  /** スキップした行数（必須フィールド欠落など）。 */
  skipped: number;
  /** 読み込み元。 */
  source: string;
}

/**
 * JSONL / JSON から SWE-bench instance を読み込む。
 * - `.jsonl`: 1 行 1 instance
 * - `.json`: 配列 or {instances: [...]}
 */
export async function loadSweBenchInstances(filePath: string): Promise<InstanceLoadResult> {
  const text = await fs.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  let rows: unknown[] = [];

  if (ext === '.jsonl') {
    rows = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  } else {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { instances?: unknown[] }).instances)) {
      rows = (parsed as { instances: unknown[] }).instances;
    } else {
      throw new Error(`swe instance ファイル形式が不明です: ${filePath}（配列 or {instances: []} を期待）`);
    }
  }

  const instances: SweBenchInstance[] = [];
  let skipped = 0;
  for (const r of rows) {
    // null / 非オブジェクト行はスキップ（壊れた行で throw しない）
    if (r === null || typeof r !== 'object') {
      skipped++;
      continue;
    }
    const row = r as Partial<SweBenchInstance> & { FAIL_TO_PASS?: unknown; PASS_TO_PASS?: unknown };

    // FAIL_TO_PASS / PASS_TO_PASS は配列 or JSON 文字列（例: HuggingFace parquet 由来の
    // 生データでは '["test/..."]' のような JSON 文字列で格納される）。文字列ならパースする。
    const parseList = (v: unknown): string[] | null => {
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
      if (typeof v === 'string') {
        try {
          const p = JSON.parse(v);
          return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : null;
        } catch {
          return null;
        }
      }
      return null;
    };
    const f2p = parseList(row.FAIL_TO_PASS);
    const p2p = parseList(row.PASS_TO_PASS);

    const hasRequired =
      typeof row.instance_id === 'string' &&
      typeof row.repo === 'string' &&
      typeof row.base_commit === 'string' &&
      typeof row.problem_statement === 'string' &&
      f2p !== null &&
      p2p !== null;
    if (!hasRequired) {
      skipped++;
      continue;
    }
    instances.push({
      instance_id: row.instance_id as string,
      repo: row.repo as string,
      base_commit: row.base_commit as string,
      patch: typeof row.patch === 'string' ? row.patch : undefined,
      test_patch: typeof row.test_patch === 'string' ? row.test_patch : undefined,
      problem_statement: row.problem_statement as string,
      FAIL_TO_PASS: f2p as string[],
      PASS_TO_PASS: p2p as string[],
    });
  }

  return { instances, skipped, source: filePath };
}

/** instance_id から表示用の短い名前（owner/repo#PR）を作る。 */
export function instanceLabel(inst: SweBenchInstance): string {
  return `${inst.repo}@${inst.base_commit.slice(0, 8)} (${inst.instance_id})`;
}
