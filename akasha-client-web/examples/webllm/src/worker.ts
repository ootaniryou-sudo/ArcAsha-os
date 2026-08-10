/// <reference lib="webworker" />
/**
 * WebLLM 推論 Worker — メインスレッドと MLCEngine の橋渡し。
 * WebWorkerMLCEngineHandler が全メッセージプロトコルを処理する。
 */
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};
