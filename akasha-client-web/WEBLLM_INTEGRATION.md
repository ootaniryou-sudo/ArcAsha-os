# WebLLM 統合設計 — iPhone で WebGPU 推論を動かす

> 作成: 2026-08-10
> 目的: WebLLM (https://webllm.mlc.ai) の技術を ArcAsha に参考・統合し、
> iPhone (iOS 18+) の Safari 上で WebGPU を使った本物の LLM 推論を実現する設計。

---

## 1. 結論（要旨）

- **実現可能**。かつ ArcAsha との相性は非常に良い。
- 重要な事実修正: `akasha-master/src/arcasha/nodes/ios-metal/README.md` の
  「WebGPU が使えない iOS のため推論は Metal で実行」という記述は**古い**。
  **iOS 18 / Safari 26（2024年〜）から iPhone/iPad は WebGPU を標準サポート**。
- WebLLM は **Qwen3-0.6B / Qwen2.5-0.5B / SmolLM2-135M・360M** などを
  標準サポートしており、ArcAsha の実験基盤（`experiments/qwen3_0.6b/`）や
  iOS Metal ノード（SmolLM2-135M）と**モデルが完全に重なる**。
- 推奨アーキテクチャ: **WebLLM を「WebGPU/LLM エキスパート」として ArcAsha に
  組み込む**（ArcAsha の哲学「Expert = 計算バックエンド」に完全適合）。

---

## 2. WebLLM とは（技術の仕組み）

### 2.1 全体像

```
[HuggingFace: MLC 量子化済みモデル]   [webgpu.wasm モデルライブラリ]
        │ ダウンロード                      │ TVM で事前コンパイル済み
        ▼                                  ▼
[MLCEngine (Web Worker)] ── WebGPU ──▶ [WASM + WGSL compute shaders]
        │
        ▼
[OpenAI 互換 API: chat.completions / streaming / JSON mode / function calling]
```

- **MLC-LLM / Apache TVM 基盤**: モデルを WebGPU (WGSL) シェーダ + WASM に
  事前コンパイル。手書き WGSL 不要で、重い GEMM/アテンションが最適化済み。
- **量子化**: `q4f16` / `q4f32` / `q0f16` / `q0f32` など。低 VRAM デバイス
  （iPhone）向けに `low_resource_required: true` フラグ付きモデルが用意されている。
- **メモリ計画・KV cache・paged attention**: スマホの限られた VRAM でも動作。
- **Worker 対応**: `WebWorkerMLCEngineHandler`（Worker 側）/ `CreateWebWorkerMLCEngine`
  （メイン側）。**ArcAsha の `akasha-client-web`（Worker で推論）と構造が同型**。
- **Service Worker 対応**: ページ再訪時にモデルの再ロードを回避。
- **キャッシュ**: Cache API（既定）/ IndexedDB / OPFS から選択可。

### 2.2 主要 API（統合で使うもの）

```ts
import { CreateMLCEngine, CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm';

// メインスレッド（Worker 版）
const engine = await CreateWebWorkerMLCEngine(
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  'Qwen3-0.6B-q0f32-MLC',          // ← ArcAsha 実験と同一モデルファミリ
  { initProgressCallback },          // ロード進捗
);

// OpenAI 互換
const reply = await engine.chat.completions.create({ messages });
const chunks = await engine.chat.completions.create({ messages, stream: true });
```

### 2.3 iPhone 向けに重要な設計要素

| 要素 | 内容 |
|---|---|
| `low_resource_required` | 低 VRAM デバイス向けフラグ。iPhone ではこれを選択 |
| `vram_required_MB` | モデル選択の判断材料（例: Qwen2.5-0.5B ≈ 945MB, SmolLM2-135M ≈ 359MB） |
| `detectGPUDevice()` | WebGPU 非対応環境の検出。**非対応なら既存の Metal ノード等へフォールバック** |
| `shader-f16` 要件 | 一部モデルは `required_features: ["shader-f16"]`。iPhone は対応済み |
| `context_window_size` | メモリ削減のため 1024〜4096 に縮小可能 |

---

## 3. 現在の ArcAsha の実態（統合前に把握すべき事実）

### 3.1 `akasha-client-web` の WebGPU エンジンはプレースホルダー

`src/worker.ts` の `WebGpuLayerEngine` は **実モデルではなくスタブ**:

```wgsl
fn hash_weight(layer : i32, i : u32) -> f32 { ... }  // 決定的ハッシュで擬似重み
output[i] = silu(x * w + b);                          // 実モデルの重みではない
```

コメントにも「Real deployments swap this WGSL for shard weights」とあり、
「1 デバイスが 1 層のアクティベーションを計算する分散エッジ」構想のデモ実装。
→ **WebLLM はこのプレースホルダーを「本物の推論エンジン」に置き換える最有力候補**。

### 3.2 iOS Metal ノードの前提が古い

`nodes/ios-metal/README.md`:
> WebGPU が使えない iOS のため、推論は Metal (llama.cpp + ggml-metal) で実行

→ iOS 18+ では WebGPU が使えるため、**この前提は更新が必要**。
WebGPU 版（=WebLLM 統合）が動けば、ネイティブアプリを介さず Safari だけで
iPhone を実行ノードにできる。

### 3.3 ハブは「chat 系エッジノード」を既にサポート

iOS Metal ノードは `family=metal → chat=true` として JSON over WS で
ハブに登録・compute/result をやり取りしている。
→ WebLLM ノードも同じ枠組みで `family=webllm → chat=true` として登録可能。

---

## 4. 統合アーキテクチャ（推奨）

### 4.1 位置づけ

```
                        ArcAsha Hub (オーケストレーション)
   AILSM コンパイラ / AILSA / ODAR / エキスパートルーティング / メモリ
        │ WS (JSON: register / compute / result)
        ▼
┌─────────────────────────────────────────────────┐
│ akasha-client-web (iPhone Safari のエッジノード) │
│   ┌──────────────────────────────────────────┐  │
│   │ WebLLM エキスパート（新規: webllm-expert）│  │
│   │  ├─ MLCEngine (Web Worker)              │  │
│   │  ├─ WebGPU 検出 → 非対応はフォールバック  │  │
│   │  └─ ExpertMessage 規約へのラップ         │  │
│   └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 4.2 エキスパートラッパー設計（`webllm-expert.ts`）

ArcAsha の ExpertMessage 規約（FROM/TO/TASK_ID/INPUT/RESULT/CONF/TRACE）に
適合させる薄いラッパー:

```ts
interface WebLlmExpert {
  family: 'webllm';
  chat: true;
  load(modelId: string, onProgress): Promise<void>;   // MLCEngine ロード
  complete(input: ExpertInput): Promise<ExpertResult>; // chat.completions に変換
  unload(): Promise<void>;                             // VRAM 解放
}
```

- `INPUT`（自然言語 or AILSM シリアライズ）→ `messages` に変換
- `RESULT` → `reply.choices[0].message.content` + `usage`（トークン数）
- `CONF` → サンプリング温度・logits 情報（WebLLM は logit-level 制御可）
- `TRACE` → レイテンシ・トークン/秒・VRAM 使用量（既存ダッシュボードに表示）

### 4.3 モデル選択（iPhone 向け推奨）

| 段階 | モデル | VRAM | 備考 |
|---|---|---|---|
| PoC | **Qwen3-0.6B-q0f32-MLC** | ~3.8GB | ArcAsha 実験と同一ファミリ |
| 実用 | **Qwen2.5-0.5B-Instruct-q4f16** | ~945MB | 低リソース向け |
| 軽量 | **SmolLM2-135M/360M** | ~360-580MB | 現在の iOS Metal ノードと同等 |

### 4.4 フォールバック戦略

1. `navigator.gpu` なし / `detectGPUDevice()` 失敗 → 「WebGPU 非対応」を明示
2. 既存の **プレースホルダー shader モード**（層計算デモ）は残す
3. チャット推論は WebLLM ノード、層計算デモは既存 Worker と**共存**

---

## 5. 実装プラン（フェーズ分け）

### Phase 0: PoC（本リポジトリ内 `examples/webllm/` として先行実装）
- [x] WebLLM 技術調査（本設計書）
- [x] スタンドアロン PoC: `CreateWebWorkerMLCEngine` + チャット UI
- [x] **デスクトップブラウザで動作検証済み（2026-08-10, Mac + Apple Metal）**
  - モデル: SmolLM2-135M-Instruct-q0f16-MLC
  - 初回ロード: 38.9s（~360MB ダウンロード）→ キャッシュ後: **0.6s**
  - 推論: **77.0 tok/s**（127 tokens / 1648ms, max_tokens=128 制限）
  - WebGPU 検出: ✅ apple metal-3 / ストリーミング表示 / 統計表示 すべて正常
- [ ] **iPhone Safari で動作確認**（要実機）: Qwen3-0.6B / SmolLM2-135M
- [ ] 測定: 初回ロード時間 / トークン/秒 / VRAM / バッテリー影響

### Phase 1: エキスパート化
- [ ] `akasha-client-web/src/webllm-expert.ts` を実装（ExpertMessage 規約適合）
- [ ] 既存ダッシュボード（`main.ts`）に WebLLM モード切替を追加
- [ ] WebGPU 非対応時のフォールバック分岐

### Phase 2: ハブ統合
- [ ] ハブ `KNOWN_PARAMS` に `webllm` ファミリを登録（`chat=true`）
- [ ] iOS Metal ノードと並列でルーティング可能に
- [ ] `demo-web.ts` から iPhone Safari ノードへ推論委譲のデモ

### Phase 3: 研究
- [ ] 「WebGPU ブラウザ推論 vs iOS Metal ネイティブ」のレイテンシ・品質比較
- [ ] Native Expert / 分散エッジ論文の材料として活用
- [ ] `nodes/ios-metal/README.md` の「WebGPU 不可」記述を更新

---

## 6. リスク・制約

| リスク | 影響 | 対策 |
|---|---|---|
| 初回モデルダウンロード | Qwen3-0.6B で数 GB | Cache API / OPFS で 2 回目以降は即時 |
| iPhone の VRAM 制限 | 大きなモデルは OOM (device lost) | 0.5B〜1.7B クラス + context 縮小 |
| バッテリー / 発熱 | 長時間推論で発熱 | Worker 化 + 必要時のみロード/unload |
| iOS Safari の WebGPU 差異 | 挙動差の可能性 | `detectGPUDevice()` + 機能検出 |
| モデルライセンス | Qwen 等は各社ライセンス | 実験用途は研究目的に限定 |

---

## 7. 参考文献

- WebLLM: https://webllm.mlc.ai / https://github.com/mlc-ai/web-llm
- WebLLM 論文: arXiv:2412.15803 (Ruan et al., 2026)
- MLC-LLM: https://github.com/mlc-ai/mlc-llm / https://llm.mlc.ai
- MLC Models: https://mlc.ai/models
- WebGPU (W3C): https://www.w3.org/TR/webgpu/
- iOS 18 WebGPU: Safari 26 Release Notes
