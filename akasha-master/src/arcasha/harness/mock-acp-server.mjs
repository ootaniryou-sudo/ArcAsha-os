#!/usr/bin/env node
/**
 * Mock ACP サーバー（H2-B セルフテスト用フィクスチャ）— 実 ACP ワイヤープロトコルを話す。
 *
 * @agentclientprotocol/sdk の AgentSideConnection を stdio に接続し、
 * initialize → session/new → session/prompt → session/cancel を決定論的に応答する。
 * API キー不要。環境変数で挙動を制御する:
 *
 *   MOCK_TEXT         プロンプト応答前に agent_message_chunk として流すテキスト（既定: "ok"）
 *   MOCK_STOP         prompt 応答の stopReason（既定: "end_turn"）
 *   MOCK_FAIL         1 なら prompt を RPC エラーで reject（→ タスク失敗）
 *   MOCK_CRASH        1 なら prompt で process.exit(1)（→ infrastructure failure）
 *   MOCK_PERMISSION   1 なら応答前に session/request_permission を要求する
 *   MOCK_HANG         1 なら prompt を session/cancel まで保留する
 *
 * 実行: node mock-acp-server.mjs（stdout は ACP フレーム専用。診断は stderr のみ）
 */
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const TEXT = process.env.MOCK_TEXT ?? 'ok';
const STOP = process.env.MOCK_STOP ?? 'end_turn';
const FAIL = process.env.MOCK_FAIL === '1';
const CRASH = process.env.MOCK_CRASH === '1';
const PERMISSION = process.env.MOCK_PERMISSION === '1';
const HANG = process.env.MOCK_HANG === '1';

/** HANG 時に session/cancel で解決するための promise。 */
let hangResolve = () => {};
const hangPromise = new Promise((resolve) => { hangResolve = resolve; });

let seq = 0;

new AgentSideConnection(
  (conn) => ({
    initialize() {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
      });
    },
    authenticate() {
      return Promise.resolve();
    },
    newSession() {
      seq += 1;
      return Promise.resolve({ sessionId: `mock-session-${seq}` });
    },
    async prompt(params) {
      if (CRASH) process.exit(1);
      if (PERMISSION) {
        const decision = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'mock-call', title: 'mock side effect' },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        const out = decision.outcome;
        if (out.outcome === 'cancelled') {
          return { stopReason: 'cancelled' };
        }
        if (out.outcome === 'selected' && out.optionId === 'no') {
          // 拒否は失敗結果（refusal）として変換する
          return { stopReason: 'refusal' };
        }
        // selected && optionId === 'yes' → 許可して続行
      }
      if (FAIL) {
        throw new Error('mock task failure');
      }
      if (HANG) {
        await hangPromise;
        return { stopReason: 'cancelled' };
      }
      if (TEXT.length > 0) {
        await conn.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'mock-msg-1',
            content: { type: 'text', text: TEXT },
          },
        });
      }
      return { stopReason: STOP };
    },
    cancel() {
      hangResolve();
      return Promise.resolve();
    },
  }),
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);

// stdin EOF = クライアント側の切断。graceful に終了する。
process.stdin.on('end', () => {
  process.exit(0);
});
