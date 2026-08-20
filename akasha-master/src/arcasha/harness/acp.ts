/**
 * ACP（Agent Client Protocol）クライアント — dsh ACP サーバーへの stdio 接続。
 *
 * @agentclientprotocol/sdk の ClientSideConnection を子プロセスの stdio に接続し、
 * initialize → session/new → session/prompt → session/cancel を駆動する。
 *
 * - dsh 固有の型をこのモジュールの外へ漏らさない（写像は deepseek.ts / events.ts で行う）
 * - 起動不能・通信喪失・タイムアウトは HarnessInfrastructureError（iterator throw 側）
 * - AbortSignal は adapter 側が session/cancel 通知へ変換して伝播する
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type Client,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { HarnessInfrastructureError } from './types.js';

/** ACP サーバーの起動仕様。 */
export interface AcpServerSpec {
  /** 実行ファイル（lockfile 解決済みの絶対パス or コマンド名）。 */
  command: string;
  args?: string[];
  /** 子プロセスの作業ディレクトリ。省略時は process.cwd()。 */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AcpClientOptions {
  /** ACP サーバーの起動コマンド。 */
  server: AcpServerSpec;
  /** セッションの作業ディレクトリ（session/new へ渡す絶対パス）。 */
  sessionCwd: string;
  /** 権限要求の自動応答ポリシー（既定: reject = fail closed）。 */
  permission?: 'allow' | 'reject';
  /** 各 ACP リクエストのタイムアウト（ms）。既定 300_000。 */
  requestTimeoutMs?: number;
  /** agent_message_chunk（テキスト）ごとに呼ばれる（順序保証）。 */
  onMessage?: (text: string) => void;
  /** 子プロセスの stderr 行（診断用）。 */
  onStderr?: (line: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
/** graceful 終了 → SIGTERM → SIGKILL の各段階の猶予。 */
const CLOSE_STAGE_MS = 1_000;

/** 子プロセス stdio を Web Stream 化して ACP の Stream に接続する。 */
function connectStreams(child: ChildProcess): ReturnType<typeof ndJsonStream> {
  return ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
}

/** 未知の例外を HarnessInfrastructureError へ正規化する。 */
function toInfrastructure(e: unknown, what: string): HarnessInfrastructureError {
  if (e instanceof HarnessInfrastructureError) return e;
  if (e instanceof RequestError) {
    return new HarnessInfrastructureError(`${what} で ACP エラー: ${e.message}`, 'DSH_ACP_REQUEST_ERROR');
  }
  const message = e instanceof Error ? e.message : String(e);
  return new HarnessInfrastructureError(`${what} で失敗: ${message}`);
}

/** タイムアウト付き promise。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new HarnessInfrastructureError(`${what} がタイムアウト（${ms}ms）`));
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(toInfrastructure(e, what));
      },
    );
  });
}

/** 単純な async queue（generator へメッセージを流す）。 */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(v: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  /** 終端。待機中の next() を done:true で解放する。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  /** 待たずに取得。空なら null。 */
  tryNext(): IteratorResult<T> | null {
    const item = this.items.shift();
    if (item !== undefined) return { value: item, done: false };
    return null;
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/**
 * ACP サーバーへの接続を表すクライアント。生成後は必ず close() する。
 */
export class AcpClient {
  private readonly opts: AcpClientOptions;
  private readonly child: ChildProcess;
  private readonly conn: ClientSideConnection;
  private readonly messages = new AsyncQueue<string>();
  private readonly childExited: Promise<void>;
  private sessionId: string | null = null;
  private lastWrite: Promise<void> | null = null;
  private closed = false;

  private constructor(opts: AcpClientOptions, child: ChildProcess) {
    this.opts = opts;
    this.child = child;
    this.childExited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    // 子プロセス終了時はメッセージキューを終端し、待機中の next() を解放する
    void this.childExited.then(() => this.messages.end());
    this.conn = new ClientSideConnection(
      (_agent: AcpAgent): Client => ({
        sessionUpdate: (params: SessionNotification): Promise<void> => {
          const update = params.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            this.messages.push(update.content.text);
            opts.onMessage?.(update.content.text);
          }
          return Promise.resolve();
        },
        requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
          if (opts.permission === 'allow') {
            const allow = params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
            if (allow !== undefined) {
              return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
            }
          } else {
            // 拒否は protocol レベルの cancelled ではなく、reject オプションの明示選択で返す
            const reject = params.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
            if (reject !== undefined) {
              return Promise.resolve({ outcome: { outcome: 'selected', optionId: reject.optionId } });
            }
          }
          // 該当オプションが無い場合のみ fail closed として cancelled で応答する
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        },
      }),
      connectStreams(child),
    );
    if (opts.onStderr !== undefined) {
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim() !== '') opts.onStderr?.(line);
        }
      });
    }
  }

  /** 子プロセスを起動し、ACP initialize まで完了してから返す。失敗時は子プロセスを回収して throw。 */
  static async connect(opts: AcpClientOptions): Promise<AcpClient> {
    const child = spawn(opts.server.command, opts.server.args ?? [], {
      cwd: opts.server.cwd,
      env: { ...process.env, ...opts.server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new AcpClient(opts, child);
    try {
      await client.initialize();
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
    return client;
  }

  private request<T>(fn: () => Promise<T>, what: string): Promise<T> {
    const ms = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const raced = Promise.race([
      fn(),
      this.childExited.then(() => {
        throw new HarnessInfrastructureError(`ACP 子プロセスが終了しました（${what}）`);
      }),
    ]);
    return withTimeout(raced, ms, what);
  }

  private async initialize(): Promise<void> {
    await this.request(
      () => this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      'ACP initialize',
    );
  }

  /** 新規セッションを作成し、sessionId を返す。 */
  async newSession(): Promise<string> {
    const res = await this.request(
      () => this.conn.newSession({ cwd: this.opts.sessionCwd, mcpServers: [] }),
      'ACP session/new',
    );
    this.sessionId = res.sessionId;
    return res.sessionId;
  }

  /**
   * 1 ターンのプロンプトを実行する。agent_message_chunk は onMessage へ流れる。
   * resolve 時に stopReason を持つ PromptResponse が返る。
   */
  prompt(text: string): Promise<PromptResponse> {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return Promise.reject(new HarnessInfrastructureError('ACP session 未作成のまま prompt を呼び出し'));
    }
    return this.request(
      () => this.conn.prompt({ sessionId, prompt: [{ type: 'text', text }] }),
      'ACP session/prompt',
    );
  }

  /** 進行中ターンのキャンセル通知（best-effort）。close() が EOF 前に書き込み完了を待てるよう記録する。 */
  cancel(): void {
    const sessionId = this.sessionId;
    if (sessionId === null || this.closed) return;
    this.lastWrite = this.conn.cancel({ sessionId }).then(
      () => undefined,
      () => undefined,
    );
  }

  /** メッセージキューを終端し、待機中の nextMessage() を done:true で解放する。 */
  endMessages(): void {
    this.messages.end();
  }

  /** 次の agent_message_chunk テキストを待って返す。 */
  nextMessage(): Promise<IteratorResult<string>> {
    return this.messages.next();
  }

  /** 待たずに取得。空なら null。 */
  tryNextMessage(): string | null {
    const v = this.messages.tryNext();
    return v === null || v.done ? null : v.value;
  }

  /**
   * 子プロセスを終了する（graceful: stdin EOF → SIGTERM → SIGKILL）。冪等。
   * cancel などの保留中の ACP 書き込みが完了してから EOF を送る（ERR_STREAM_WRITE_AFTER_END 防止）。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.messages.end();
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // 保留中の書き込み（session/cancel など）を EOF より先に完了させる
    if (this.lastWrite !== null) {
      await this.lastWrite;
    }
    // ACP サーバーは stdin EOF で graceful に dispose する（dsh-acp-demo の契約）
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await Promise.race([this.childExited, sleep(CLOSE_STAGE_MS)]);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([this.childExited, sleep(CLOSE_STAGE_MS)]);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await this.childExited;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
