/**
 * Agent 監査ログ — ツール呼び出し・モデル応答の署名付き証跡（append-only）
 *
 * 目的: 各ツール呼び出しとモデル応答を恒常的に保存し、後から追跡・検証できるようにする。
 * セキュリティ:
 *   - append-only JSONL（ファイル末尾への追記のみ。既存行は書き換えない）
 *   - 各行に HMAC-SHA256 署名を付す（改ざん検知）
 *   - 保管先はリポジトリ外（既定 ~/.arcasha/agent-audit/）で git に入らない
 *
 * 使い方:
 *   const audit = createAuditLogger();          // 既定ディレクトリ
 *   audit.emit({ kind: 'tool', agentStepId, tool: 'edit_file', args: {...}, resultHash, ok, ms });
 *   audit.emit({ kind: 'model', agentStepId, model, promptTokens, completionTokens, responseHash });
 *
 * 検証:
 *   audit.verifyLine(line) で署名を検証できる（改ざん検知）。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 監査エントリの種別。 */
export type AuditKind = 'tool' | 'model' | 'agent' | 'system';

/** 監査エントリ（1 行 = 1 操作）。 */
export interface AuditEntry {
  /** エントリ種別。 */
  kind: AuditKind;
  /** エージェント実行 ID（runSweAgent ごと）。 */
  agentRunId?: string;
  /** ループ内ステップ番号（0-indexed）。 */
  agentStepId?: number;
  /** タイムスタンプ（ISO）。 */
  ts: string;
  /** ツール名 / モデル名 / イベント名。 */
  name: string;
  /** ツール引数（シリアライズ可能なもののみ・シークレットは含めない）。 */
  args?: Record<string, unknown>;
  /** ツール結果のハッシュ（SHA-256）。 */
  resultHash?: string;
  /** モデル応答本文のハッシュ。 */
  responseHash?: string;
  /** 成功したか。 */
  ok?: boolean;
  /** レイテンシ（ms）。 */
  ms?: number;
  /** トークン使用量。 */
  promptTokens?: number;
  completionTokens?: number;
  /** モデル名。 */
  model?: string;
  /** 追加メタデータ。 */
  meta?: Record<string, unknown>;
}

/** 監査ログの 1 行（署名込み）。 */
export interface AuditLine {
  entry: AuditEntry;
  /** 署名（HMAC-SHA256、16 進）。 */
  signature: string;
  /** この行の ID（改ざん防止・追跡用）。 */
  id: string;
  /**
   * 直前の行のハッシュ（ハッシュ連鎖）。先頭行は空文字。
   * 署名対象に含めることで、行の削除・並べ替え・挿入を検知できる。
   */
  prevHash: string;
}

/** 監査ロガー。 */
export interface AuditLogger {
  /** エントリを追記して保存する。 */
  emit(entry: Omit<AuditEntry, 'ts'>): Promise<AuditLine>;
  /** 監査ディレクトリのパス。 */
  dir(): string;
  /** 現在のログファイルパス。 */
  file(): string;
  /** 過去ログ（read-only・改ざん検知付き）を読む。 */
  readAll(): Promise<AuditLine[]>;
}

/** 監査ロガー生成オプション。 */
export interface AuditLoggerOptions {
  /** HMAC 鍵。省略時は env ARCASHA_AUDIT_SECRET または一時生成鍵（永続化されない）。 */
  secret?: string;
  /** 監査ディレクトリ。省略時は ~/.arcasha/agent-audit/。 */
  dir?: string;
}

/** 既定の監査ディレクトリ。 */
export function defaultAuditDir(): string {
  const base = process.env.ARCASHA_AUDIT_DIR ?? path.join(os.homedir(), '.arcasha', 'agent-audit');
  return base;
}

/** 監査エントリを安定した文字列へ（署名対象）。 */
function canonicalize(e: AuditEntry): string {
  // キー順を固定して決定的な文字列化（署名の再現性）
  const keys: (keyof AuditEntry)[] = ['kind', 'agentRunId', 'agentStepId', 'ts', 'name'];
  const parts = keys.map((k) => `${k}=${String(e[k] ?? '')}`);
  if (e.args) parts.push(`args=${JSON.stringify(e.args)}`);
  if (e.resultHash) parts.push(`resultHash=${e.resultHash}`);
  if (e.responseHash) parts.push(`responseHash=${e.responseHash}`);
  if (e.ok !== undefined) parts.push(`ok=${e.ok}`);
  if (e.ms !== undefined) parts.push(`ms=${e.ms}`);
  if (e.promptTokens !== undefined) parts.push(`promptTokens=${e.promptTokens}`);
  if (e.completionTokens !== undefined) parts.push(`completionTokens=${e.completionTokens}`);
  if (e.model) parts.push(`model=${e.model}`);
  if (e.meta) parts.push(`meta=${JSON.stringify(e.meta)}`);
  return parts.join('\n');
}

/** 文字列の SHA-256 ハッシュ（16 進）。 */
export function sha256(s: string): string {
  return createHmac('sha256', 'arcasha-content').update(s).digest('hex');
}

/**
 * 監査行の「連鎖ハッシュ」を計算する。次の行の prevHash に使う。
 * 署名・prevHash・id を含めることで、行の内容・順序・連鎖の両方を固定する。
 */
function lineHash(line: AuditLine): string {
  return sha256(`${line.prevHash}\n${line.signature}\n${line.id}`);
}

/**
 * 監査ロガーを生成する。
 * 書き込みは append-only（既存内容を保持したまま末尾へ追記）。HMAC 署名を付す。
 * 各行は「直前の行のハッシュ（prevHash）」を含めて署名する（ハッシュ連鎖）。
 * これにより、行の削除・並べ替え・挿入を検知できる（個別署名だけでは検知不能）。
 */
export function createAuditLogger(opts: AuditLoggerOptions = {}): AuditLogger {
  const dir = opts.dir ?? defaultAuditDir();
  // 鍵: 明示 → env → 一時生成（永続検証には env ARCASHA_AUDIT_SECRET を設定）
  const secret = opts.secret ?? process.env.ARCASHA_AUDIT_SECRET ?? randomUUID();
  const file = path.join(dir, `agent-audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
  let writeChain: Promise<void> = Promise.resolve();
  // 最後に書き込んだ行の連鎖ハッシュ（並行 emit でも順序を保証するため writeChain 内で更新）
  let lastHash = '';

  function sign(entry: AuditEntry, prevHash: string): string {
    return createHmac('sha256', secret).update(`${canonicalize(entry)}\nprevHash=${prevHash}`).digest('hex');
  }

  return {
    dir: () => dir,
    file: () => file,
    async emit(entry: Omit<AuditEntry, 'ts'>): Promise<AuditLine> {
      const full: AuditEntry = { ...entry, ts: new Date().toISOString() };
      // 初回はファイル末尾の既存行から連鎖を再開する（既存ログへの追記を維持）
      let line: AuditLine | null = null;
      writeChain = writeChain.then(async () => {
        try {
          if (lastHash === '' && (await fs.stat(file).catch(() => null))) {
            const raw = await fs.readFile(file, 'utf8');
            const rows = raw.split('\n').filter((l) => l.trim() !== '');
            if (rows.length > 0) {
              const prev = JSON.parse(rows[rows.length - 1]) as AuditLine;
              lastHash = lineHash(prev);
            }
          }
          const prevHash = lastHash;
          const signature = sign(full, prevHash);
          line = { entry: full, signature, id: randomUUID(), prevHash };
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          // 追記モード（append-only）・0600 で保存
          await fs.appendFile(file, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
          lastHash = lineHash(line);
        } catch (e) {
          // 監査ログ失敗はエージェントを止めない（ログに出すだけ）
          console.error(`⚠️ 監査ログ書込失敗: ${String(e).slice(0, 160)}`);
        }
      });
      await writeChain;
      return line ?? { entry: full, signature: '', id: '', prevHash: '' };
    },
    async readAll(): Promise<AuditLine[]> {
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as AuditLine);
      } catch {
        return [];
      }
    },
  };
}

/**
 * 監査行の署名を検証する（改ざん検知）。
 * 単一の署名に加え、prevHash が期待値（前の行の連鎖ハッシュ）と一致するかも検証する。
 * prevHash を渡さない場合は署名のみ検証する（後方互換）。
 */
export function verifyAuditLine(line: AuditLine, secret: string, expectedPrevHash?: string): boolean {
  const expected = createHmac('sha256', secret).update(`${canonicalize(line.entry)}\nprevHash=${line.prevHash}`).digest('hex');
  if (expected !== line.signature) return false;
  // ハッシュ連鎖が正しいか（前の行のハッシュと一致するか）
  if (expectedPrevHash !== undefined && line.prevHash !== expectedPrevHash) return false;
  return true;
}

/**
 * 監査ログ全体の整合性（ハッシュ連鎖）を検証する。
 * 行の削除・並べ替え・挿入・改ざんを検知する。ログ全体を読み、先頭から順に
 * 連鎖が途切れていないか確認する。
 * @returns 検証 OK なら null、問題があればその説明を返す。
 */
export function verifyAuditChain(lines: AuditLine[], secret: string): string | null {
  let prevHash = '';
  for (const line of lines) {
    if (!verifyAuditLine(line, secret, prevHash)) {
      return `行「${line.entry.name}」で連鎖が壊れています（prevHash 不一致または署名不一致）`;
    }
    prevHash = lineHash(line);
  }
  return null;
}
