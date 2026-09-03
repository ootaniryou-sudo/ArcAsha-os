# ArcAsha（アーカーシャ / Akasha-OS）

> **AI のためのオペレーティングシステム — モジュール型推論とランタイム知能**

ArcAsha は**モデルではありません**。ニューラルモデルの**上で動く OS** です — 推論を OS レベルで**構成・制御・計測・説明**します。

- モデルは**改造しません**。
- モデルの**外側に OS レイヤー**を置き、ルーティング・メモリ・推論・スケジューリング・自己改善を管理します。

> **中心的な研究課題**: モデルを巨大化するのではなく、知能を OS レベルで構成・制御・計測し、再現可能な形で証明できるか。

---

## 🎯 なぜ ArcAsha か

GPT / MoE は推論をすべて**ニューラルネット内部**（ブラックボックス）で行います。

ArcAsha は推論をモデルの**外側**へ出します：

```
Task → Compiler → AILSM IR → Kernel → Executive → Hypothesis → Search → Experts → Memory
```

- **AILSM / AILSA**: AI 専用の中間表現と命令セット（推論の「機械語」）
- **AVM**: AI 仮想メモリ（必要な文脈だけを需要ページングで供給）
- **Executive / Meta Executive**: 推論全体を指揮し、自身のポリシーを学習
- **Intelligence Attachments**: 必要な時だけロードする高度知能（Linux のオプションカーネルモジュール相当）

---

## 🏗️ 3 層アーキテクチャ

```
Layer 3  Intelligence Attachments（Reflection / Debate / Planning / Search / Creativity / Simulation / Coding）
Layer 2  Executive Runtime（Executive / Meta Executive / Expert Evolution / Intelligence Scheduler）
Layer 1  Fast Runtime（Kernel / AVM / Expert Runtime / ODAR / Device Tree）— 常に高速
```

**Fast と Deliberation の分離**: Fast はリアルタイム制御を維持（ロボット 30.3fps）、Deliberation は必要な時だけロード（研究・長時間推論）。

## ✨ 主な機能

- **AVM**: 仮想メモリとしての文脈管理（実 API 検証・長文コンテキスト: **トークン 96.5% 削減・精度 100%** — 旧表記の 4.10x / −77% は**分離前**の計測）
- **Executive / Meta Executive**: 探索を指揮し、観測結果から自身のポリシーを学習
- **Expert Evolution**: Expert が客観的基準（健康度・機能重複・利用率）で分裂・統合・引退
- **Thinking Modes**: Fast / Auto / Deep / Custom — 同じ OS でパイプラインを変更
- **Explainable**: **Decision Explanation**（なぜこの構成か）/ **Decision Replay**（ステップ再生）/ **OS Policy Learning**（意思決定を学習データに）
- **Validation**: Simulation と Real Device を分離。外部ベンチ: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench（Qwen1.5B の行は**分離前**の simulation 計測。実 API 検証は下記 Phase 4）

---

## 🚀 クイックスタート

```bash
npm install arcasha
arcasha benchmark   # 全ベンチ（Simulation）+ Decision Explanation + reports/ 生成
arcasha replay      # 「なぜこの回答になったのか」をステップ再生
arcasha policy      # OS ポリシー学習デモ
```

リポジトリから実行する場合:

```bash
cd akasha-master
npm install
npm run ailsm:selftest          # 89 の決定論テスト
npm run benchmark               # 全ベンチ + reports/（json/csv/md）
npx tsx examples/quickstart.ts  # 5 分ツアー
```

---

## 📁 リポジトリ構成

```
akasha-master/        本体（TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments）
akasha-link/          Project A: Akasha-Link（分散推論 / テンソル伝送）
  ├── client-web/     Web クライアント（WebGPU 推論）
  └── kernel-native/  ネイティブカーネル試作（Rust）
examples/             プラグイン例（code / math）
AI_*.md               仕様書
```

## 📚 ドキュメント

`MASTER_SPEC.md`（全体像）/ `ARCASHA_V2_SPEC.md`（v2 設計 v0.36）/ `AI_REASONING.md`（推論基盤）/ `AI_ATTACHMENTS.md`（プラグイン層）/ `AI_VALIDATION.md`（検証・説明）/ `AI_VIRTUAL_MEMORY.md`（AVM）/ `PAPER_OUTLINE.md`（論文）/ `CHANGELOG.md`（履歴）

## 📊 Phase 4 — 実 API による検証

Phase 4 は各コンポーネントの効果を**実 API**（`deepseek-v4-flash`・実測・数値は偽装しない）で検証し、同一タスク・同一モデルで構成のみを比較しました。全データ: `akasha-master/reports/ablation/`。

### 構成別アブレーション（50 問 × 3 回）

| 構成 | 正答率 | 平均レイテンシ | 平均トークン |
|---|---|---|---|
| ① Baseline LLM | 98% | 1297ms | 161 |
| ② +AVM | 99% | 1256ms | 186 |
| ③ +Executive | 98% | 1334ms | 163 |
| ④ Full ArcAsha | 100% | 1442ms | 187 |

- AVM ON/OFF の有意性は **McNemar 検定**で判定（不一致 b=2 / c=0、両側 p=0.50 — 有意差なし・悪化もなし）
- タスク別詳細: `akasha-master/reports/ablation/ablation.md`（権威版）。`akasha-master/reports/ablation/ablation-quick.md` は**分離前**の quick 計測（12 問）

### 長文 AVM 効果（12,668 chars / 396 pages）

| 構成 | 正答率 | 平均入力トークン |
|---|---|---|
| モデル単体（文書なし） | 0% | 98 |
| AVM OFF（全文供給） | 100% | 8382 |
| AVM ON（関連ページのみ供給） | 100% | **290** |

- **トークン削減 96.5%・コスト削減 94.7%** で精度 100% を維持（ページ供給 39/396 = 9.8%）
- ページ境界を跨ぐ検索漏れは **ページ・オーバーラップ（スライド窓）** で修正、検索 precision は **IDF 重み付け** で向上（`akasha-master/reports/ablation-long/`）

### Executive ボトルネック（50 問）

- 計測により **`forceDelegate` 時の二重モデル呼び出しバグ**（12% のタスクで 2 回目の空/同一プロンプト呼び出し）を発見 → 修正
- 修正後: 全タスクがモデル呼び出し 1 回、Executive のレイテンシ差 **+348ms → +37ms**（+348ms は PR #37 で計測した修正前の差分、+37ms は上記アブレーション表の ③+Executive 1334ms − ①Baseline 1297ms と一致）、TS 側オーバーヘッド ≈0.2ms（`akasha-master/reports/ablation-exec/`）

## 🤖 SWE-bench 実問題検証（コーディングエージェント）

ArcAsha のソフトウェアエンジニアリングエージェント（`akasha-master/src/arcasha/swe/`）で、SWE-bench Lite の実インスタンスを**実 API**（`deepseek-v4-flash`・`temperature=0`）で解決しました。詳細: `akasha-master/README.md`。

- **SWE-bench Lite（test split）から選定した sympy 3 問**: `24213`（次元の等価性判定）/ `23117`（`Array([])`）/ `24152`（`TensorProduct.expand`）
- **結果: 3/3 解決（100%）** — モデル呼び出し 26/29/11 回・ツール 31/44/13 回・所要 93s/206s/71s（1 問あたり）。エージェントは**ソースのみ**を修正し pytest で検証。テストファイルは書込禁止（gold の `test_patch` を評価時に自動適用）
- 正直な注記: LLM は確率的で 1 問は再実行で解決。選定 3 問のため統計的な解決率の推定ではない。**トークン消費量はこの実行では未計測**（ハーネスに usage 集計を追加済み。次回以降は `akasha-master/reports/swebench/swebench-results.json` に記録）

### ノーマル DeepSeek vs arcasha（1 問・対照比較, 2026-09）

エージェント/ツール層の価値を定量化するため、**同一の 1 問** `sympy__sympy-24213` で
「素の `deepseek-v4-flash`（問題文+ファイル抜粋・1 発で unified diff を手書き）」と
「arcasha エージェント」を比較。実 API 計測。詳細:
`akasha-master/reports/swebench/compare-deepseek-vs-arcasha.md`。

- **ノーマル DeepSeek: 0/3 解決** — 毎回 gold と同一の正しい修正を特定するが、手書きの
  unified diff は hunk 行数誤り・末尾欠落で `git apply` が全試行で拒否
  （43,184 トークン / $0.027 off-peak / 267 s）
- **arcasha: 1/1 解決** — `edit_file` でファイルを直接編集するため diff は git が生成
  （手書きの hunk 計算が不要）→ 常に適用可能（741,409 トークン / $0.170 off-peak / 127 s）
- 結論: SWE-bench を解くには「修正内容が分かる」だけでなく、**実際のファイルに適用する
  ツール**が必要。素の 1 発 diff 生成は可能だが不安定

## 🧪 ステータス

- **v1.0 リリース済み** — AI OS 第一世代（ISA/IR/Kernel/AVM → 実機 → Reasoning → Executive/Meta → Attachments → Validation）
- **v1.1** — Decision Replay、実機ベンチプラン（Mac / iPhone 15 Pro / iPad M4）
- **Phase 4 実 API 検証（2026-09）** — 構成別アブレーション（Baseline/AVM/Executive/Full・50 問 × 3）+ 長文 AVM（96.5% トークン削減・精度 100%）+ Executive ボトルネック（二重呼び出しバグ修正: +348ms → +37ms）
- **SWE-bench 実問題検証（2026-09）** — SWE-bench コーディングエージェントで SWE-bench Lite から選定した sympy 3 問を解決: **3/3 解決（100%）**（deepseek-v4-flash・詳細は akasha-master/README.md）
- selftest [1]-[89] 全パス / golden 30 / AILSA selftest / build + dist 検証済み

## 🔬 研究上の位置付け

ArcAsha は「より大きなモデル」ではありません：

> **AI の知能を OS レベルで構成・制御・計測できる、再現可能な実験基盤。**

最も新しい点: OS が「なぜ Reflection / Planning / Debate を使ったのか」を**説明**でき（Decision Explanation）、意思決定プロセス全体を**再生**でき（Decision Replay）、自身の意思決定から**学習**できる（OS Policy Learning）— Transformer の事前学習とは別軸の学習です。

## ライセンス
MIT — `LICENSE` を参照。
