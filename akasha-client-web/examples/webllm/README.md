# ArcAsha × WebLLM PoC — iPhone Safari で WebGPU LLM 推論

WebLLM (https://webllm.mlc.ai) を ArcAsha の WebGPU エキスパートとして
組み込むための最初の実証（PoC）です。詳細設計は `../../WEBLLM_INTEGRATION.md`。

## 要件

- **iPhone / iPad (iOS 18+) または Safari 26+**（WebGPU 対応）
- Mac/PC でも動作確認可（Chrome / Edge / Safari 26）

## セットアップ

```bash
cd akasha-client-web/examples/webllm
npm install
npm run build      # esbuild: src/{main,worker}.ts → public/dist/*.js
npm run dev        # http://localhost:4174 で配信
```

iPhone で確認する場合: Mac の LAN IP で `http://<MacのIP>:4174` を Safari で開く
（同じ Wi-Fi に接続し、初回は「ローカルネットワーク」許可）。

## 使い方

1. 上部に WebGPU 対応が表示される（`✅` なら OK）
2. モデルを選択 → **Load**（初回は数 GB のダウンロード。Cache API に保存され
   2 回目以降は高速）
   - `Qwen3-0.6B`（~3.8GB）: ArcAsha 実験と同一ファミリ
   - `Qwen2.5-0.5B`（~945MB）: 低リソース向け推奨
   - `SmolLM2-135M`（~360MB）: iOS Metal ノードと同等
3. メッセージを送信 → ストリーミング応答 + 統計（tokens / ms / tok/s）
   （`max_tokens=128` で生成を制限、温度 0.7）

## 検証結果（2026-08-10, Mac + Apple Metal）

| 項目 | 結果 |
|---|---|
| WebGPU 検出 | ✅ apple metal-3 |
| 初回ロード（SmolLM2-135M, ~360MB） | 38.9s |
| キャッシュ後のロード | **0.6s**（Cache API 有効） |
| 推論速度 | **77.0 tok/s**（127 tokens / 1648ms） |
| ストリーミング / 統計表示 | ✅ 正常 |

> iPhone (iOS 18+) ではデスクトップより遅くなりますが、0.5B クラスなら
> 実用的な速度で動く見込み。実機での測定が次のステップ。

## 実装メモ

- `src/worker.ts`: `WebWorkerMLCEngineHandler` — 推論は Worker スレッドで実行
  （UI をブロックしない）
- `src/main.ts`: `CreateWebWorkerMLCEngine` + OpenAI 互換 `chat.completions`
- モデル ID は `@mlc-ai/web-llm` の `prebuiltAppConfig` に存在するもののみ

## 次のステップ（Phase 1+）

- `akasha-client-web/src/webllm-expert.ts` として ArcAsha の ExpertMessage
  規約（FROM/TO/TASK_ID/INPUT/RESULT/CONF/TRACE）にラップ
- ハブ `KNOWN_PARAMS` に `webllm` ファミリを登録（`chat=true`）
- 既存のプレースホルダー shader モード（層計算デモ）とは共存させる
