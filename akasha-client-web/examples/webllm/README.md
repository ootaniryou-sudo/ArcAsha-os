# ArcAsha × WebLLM PoC — iPhone Safari で WebGPU LLM 推論

WebLLM (https://webllm.mlc.ai) を ArcAsha の WebGPU エキスパートとして
組み込むための最初の実証（PoC）です。詳細設計は `../../WEBLLM_INTEGRATION.md`。

## 要件

- **iPhone / iPad (iOS 26+) / Safari 26+**（WebGPU 対応。Safari 26 は 2025年9月に WebGPU を追加）
- Mac/PC でも動作確認可（Chrome / Edge / Safari 26）

## セットアップ

```bash
cd akasha-client-web/examples/webllm
npm install
npm run build        # esbuild: src/{main,worker}.ts → public/dist/*.js
npm run dev:http     # デスクトップ検証用: http://localhost:4174 で配信
```

### iPhone 実機で確認する場合（HTTPS 必須）

**WebGPU (`navigator.gpu`) は secure context (HTTPS) でのみ公開されます。**
`http://` のままでは iPhone が WebGPU 非対応として扱われるため、mkcert で
LAN 用証明書を作成して HTTPS で配信してください。

```bash
# 1. mkcert をインストール（未導入の場合）
brew install mkcert
mkcert -install        # ローカル CA を登録

# 2. 証明書を生成（Mac の LAN IP を自動検出して .cert/ に生成）
npm run cert

# 3. HTTPS で配信
npm run dev            # https://localhost:4174

# 4. iPhone 側でローカル CA を信頼
#    - Mac で `npx serve $(mkcert -CAROOT) -p 8080` を実行（rootCA.pem を配信）
#    - iPhone Safari で http://<MacのIP>:8080/rootCA.pem を開き
#      「プロファイルをダウンロード」→ 設定 → プロファイルをインストール
#    - 設定 → 一般 → 情報 → 証明書信頼設定 でフル信頼を ON

# 5. iPhone Safari で https://<MacのIP>:4174 を開く
#    （自己署名のため警告が出たら「続ける」を選択。初回は「ローカルネットワーク」許可も必要）
```

> `mkcert -install` を実行しないと iPhone 側で証明書が信頼されません。
> デスクトップ検証のみの場合は `npm run dev:http` で問題ありません。

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

> iPhone (iOS 26+) ではデスクトップより遅くなりますが、0.5B クラスなら
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
