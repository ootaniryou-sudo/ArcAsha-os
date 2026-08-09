#!/usr/bin/env npx tsx
/**
 * ArcAsha Demo Mock Node — 実機 (iPad/iPhone) なしでハブを検証するための
 * フェイクエキスパート。register → compute → result のプロトコルだけ再現し、
 * モデル推論の代わりに固定テキストを返す (タイミングは疑似)。
 *
 * 使い方:
 *   npx tsx src/arcasha/demo-mock-node.ts --master ws://localhost:8080 --node-id mock-ios-a
 */
import WebSocket from 'ws';

interface Args { master: string; nodeId: string }

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { master: 'ws://localhost:8080', nodeId: 'mock-ios-a' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--master') out.master = args[++i];
    else if (args[i] === '--node-id') out.nodeId = args[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const { master, nodeId } = parseArgs();
  const family = nodeId.split('-').pop() || 'mock';
  const ws = new WebSocket(master);

  ws.on('open', () => {
    console.log(`  🔌 ${nodeId} → ${master}`);
    ws.send(JSON.stringify({
      type: 'register',
      node: {
        id: nodeId,
        platform: 'mock',
        device: 'Mock (no real inference)',
        role: 'expert',
        backend: 'mock',
        precision: 'mock',
        model_id: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        capabilities: { coding: 0.4, math: 0.4, general: 0.5 },
      },
    }));
  });

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
    if (msg.type === 'register_ack') {
      console.log(`  ✅ ${nodeId} registered (master=${String(msg.master ?? '')})`);
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    } else if (msg.type === 'compute') {
      const rid = String(msg.request_id ?? '');
      const prompt = String(msg.prompt ?? '');
      const maxTokens = typeof msg.max_new_tokens === 'number' ? msg.max_new_tokens : 32;
      console.log(`  📥 [${rid}] ${prompt.slice(0, 40)}...`);
      // 疑似生成: プロンプト末尾をそのまま返す (文字数 = maxTokens 相当)
      const text = `[MOCK ${family}] received "${prompt.slice(0, 60)}" (max_tokens=${maxTokens})`;
      const tokens = [...text].map((c) => c.codePointAt(0) ?? 0);
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'result',
          request_id: rid,
          tokens,
          text,
          timing: { tokenize_ms: 2, prefill_ms: 30, decode_ms: 40, total_ms: 72 },
          metadata: { node_id: nodeId, backend: 'mock', precision: 'mock', model_id: 'HuggingFaceTB/SmolLM2-135M-Instruct', platform: 'mock', role: 'expert' },
        }));
      }, 80);
    }
  });

  ws.on('close', () => console.log(`  ⏻ ${nodeId} disconnected`));
  ws.on('error', (e) => console.error(`  ❌ ${nodeId}: ${e.message}`));
  await new Promise(() => {});
}

main().catch((err) => { console.error(err); process.exit(1); });
