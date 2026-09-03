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

Phase 4 は各コンポーネントの効果を**実 API**（`deepseek-v4-flash`・実測・数値は偽装しない）で検証し、同一タスク・同一モデルで構成のみを比較しました。全データ: `reports/ablation/`。

### 構成別アブレーション（50 問 × 3 回）

| 構成 | 正答率 | 平均レイテンシ | 平均トークン |
|---|---|---|---|
| ① Baseline LLM | 98% | 1297ms | 161 |
| ② +AVM | 99% | 1256ms | 186 |
| ③ +Executive | 98% | 1334ms | 163 |
| ④ Full ArcAsha | 100% | 1442ms | 187 |

- AVM ON/OFF の有意性は **McNemar 検定**で判定（不一致 b=2 / c=0、両側 p=0.50 — 有意差なし・悪化もなし）
- タスク別詳細: `reports/ablation/ablation.md`（権威版）。`reports/ablation/ablation-quick.md` は**分離前**の quick 計測（12 問）

### 長文 AVM 効果（12,668 chars / 396 pages）

| 構成 | 正答率 | 平均入力トークン |
|---|---|---|
| モデル単体（文書なし） | 0% | 98 |
| AVM OFF（全文供給） | 100% | 8382 |
| AVM ON（関連ページのみ供給） | 100% | **290** |

- **トークン削減 96.5%・コスト削減 94.7%** で精度 100% を維持（ページ供給 39/396 = 9.8%）
- ページ境界を跨ぐ検索漏れは **ページ・オーバーラップ（スライド窓）** で修正、検索 precision は **IDF 重み付け** で向上（`reports/ablation-long/`）

### Executive ボトルネック（50 問）

- 計測により **`forceDelegate` 時の二重モデル呼び出しバグ**（12% のタスクで 2 回目の空/同一プロンプト呼び出し）を発見 → 修正
- 修正後: 全タスクがモデル呼び出し 1 回、Executive のレイテンシ差 **+348ms → +37ms**（+348ms は PR #37 で計測した修正前の差分、+37ms は上記アブレーション表の ③+Executive 1334ms − ①Baseline 1297ms と一致）、TS 側オーバーヘッド ≈0.2ms（`reports/ablation-exec/`）

## 🤖 SWE-bench 実問題検証（コーディングエージェント）

Phase 4 に続き、ArcAsha の **ソフトウェアエンジニアリングエージェント**（`src/arcasha/swe/`・ツールループ実装）で、SWE-bench Lite の実インスタンスを解決しました。数値はすべて実 API・実測です。

### 実験条件

- **対象**: `princeton-nlp/SWE-bench_Lite`（test split 300 問）から選定した **sympy/sympy の 3 問**（依存ゼロの純 Python・評価可能なものを選定）
  - `sympy__sympy-24213` — `UnitSystem._collect_factor_and_dimension()` の次元等価性判定（2022-11）
  - `sympy__sympy-23117` — `sympy.Array([])` 空配列で失敗するバグ（2022-02）
  - `sympy__sympy-24152` — `TensorProduct.expand()` が不完全な展開（2022-10）
- **モデル**: `deepseek-v4-flash`（実 API・`temperature=0`）
- **環境**: macOS / Python 3.13.2 / pytest 9.1.1 / sympy を base_commit で editable install
- **エージェント設定**: ツールループ maxIterations=50、ツール = list_dir / read_file / grep_search / glob_search / write_file / edit_file / run_command（テスト実行許可）。**テストファイル（`tests/`・`test_*.py` 等）への書込は禁止**（SWE-bench は gold の test_patch を評価時に自動適用するため）
- **評価方法**: base_commit を checkout → エージェントが**ソースのみ**を修正 → 作業ツリーを巻き戻し → gold の `test_patch` を適用 → エージェントのパッチを適用 → `FAIL_TO_PASS` / `PASS_TO_PASS` を pytest で実行 → F2P が全て pass すれば resolved。テスト名が「関数名のみ」の形式（sympy/django 仕様）はリポジトリ内を検索して node id（`ファイル::関数`）に自動解決

### 結果（3/3 = 100%）

| instance_id | resolved | model calls | tool calls | 所要時間 | パッチ |
|---|---|---|---|---|---|
| `sympy__sympy-24213` | ✅ | 26 | 31 | 93s | 717 B |
| `sympy__sympy-23117` | ✅ | 29 | 44 | 206s | 1,813 B |
| `sympy__sympy-24152` | ✅ | 11 | 13 | 71s | 930 B |

- **解決率 3/3（100%）**。F2P 全テストと P2P 回帰テストがすべて pass
- エージェントは `edit_file`/`write_file` でソースを修正し、`run_command` で pytest を実行して確認しながら解決
- **注意（正直な注記）**:
  - LLM は確率的なため実行ごとに結果は変動します（例: `23117` は 1 回の実行で「不完全応答」により未解決 → 再実行で解決。`22005` は Python 3.13 の `distutils` 非互換により評価不能のため対象外）
  - サンプル 3 問・選定バイアスがあるため、この 100% は統計的な解決率の推定ではありません
  - **トークン消費量はこの実行時点では未計測**（usage 集計の導入前）。`agent.ts` / `eval.ts` にトークン集計（`promptTokens` / `completionTokens` / `totalTokens`）を追加済みで、次回以降の実行では `reports/swebench/swebench-results.json` に記録されます
- 評価ハーネス（コード）: `src/arcasha/swe/`・コミット済み結果: `reports/swebench/swebench-results.json`

### ノーマル DeepSeek vs arcasha（1 問・対照比較, 2026-09）

エージェント/ツール層が「素のモデル呼び出し」に対して何を加えるかを定量化するため、
**同一の 1 問**（`sympy__sympy-24213`）で以下を比較しました。

- **ノーマル DeepSeek** — 素の `deepseek-v4-flash`（thinking ON・`reasoning_effort=high`）に
  問題文 **+ 対象ファイル抜粋**を与え、unified diff を 1 発で手書きさせる。3 回試行。
- **arcasha** — 上記の SWE エージェント（ツールループ）そのまま。

数値はすべて実 API 計測。費用は DeepSeek 公式 `deepseek-v4-flash` 単価
（off-peak: 入力 $0.22 / 出力 $0.66 per 1M）で概算。詳細・生データ:
`reports/swebench/compare-deepseek-vs-arcasha.{md,json}`。

| 指標 | ノーマル DeepSeek（3 試行） | arcasha |
|---|---:|---:|
| 解決 | ❌ 0/3 | ✅ 1/1 |
| 入力トークン | 3,756 | 726,877 |
| 出力トークン | 39,428 | 14,532 |
| 合計トークン | 43,184 | 741,409 |
| 時間 | 267 s（3 試行計） | 127 s |
| 費用（off-peak, $） | $0.027 | $0.170 |

**主な発見**: ノーマル DeepSeek は毎回**正しい修正内容**（gold パッチと同一の
`equivalent_dims` チェック）を特定できました。しかし unified diff を**手書き**するため、
3 回すべてで hunk ヘッダの行数カウント誤り・末尾コンテキスト欠落が起き、`git apply` が
パッチを拒否（0/3）。エージェントは `edit_file`/`write_file` でソースを**直接編集**するため、
diff は git 自身が生成（手書きの hunk 計算が不要）→ 常に適用可能 → 解決。
つまり SWE-bench を解くには「修正内容が分かる」だけでなく、**実際のファイルに適用する
ツール**が必要、というのがこの 1 問比較の結論です。

- 正直な注記: 確率的（別の 1 回実行では 1/1 解決も確認。1 発 diff 生成は可能だが不安定）・
  1 問のみのため統計的な推定ではありません。

## 🧪 ステータス

- **v1.0 リリース済み** — AI OS 第一世代（ISA/IR/Kernel/AVM → 実機 → Reasoning → Executive/Meta → Attachments → Validation）
- **v1.1** — Decision Replay、実機ベンチプラン（Mac / iPhone 15 Pro / iPad M4）
- **Phase 4 実 API 検証（2026-09）** — 構成別アブレーション（Baseline/AVM/Executive/Full・50 問 × 3）+ 長文 AVM（96.5% トークン削減・精度 100%）+ Executive ボトルネック（二重呼び出しバグ修正: +348ms → +37ms）
- **SWE-bench 実問題検証（2026-09）** — SWE-bench コーディングエージェントで SWE-bench Lite から選定した sympy 3 問を解決: **3/3 解決（100%）**（deepseek-v4-flash・1 問あたり model calls 11〜29 / 71〜206s）
- selftest [1]-[89] 全パス / golden 30 / AILSA selftest / build + dist 検証済み

## 🔬 研究上の位置付け

ArcAsha は「より大きなモデル」ではありません：

> **AI の知能を OS レベルで構成・制御・計測できる、再現可能な実験基盤。**

最も新しい点: OS が「なぜ Reflection / Planning / Debate を使ったのか」を**説明**でき（Decision Explanation）、意思決定プロセス全体を**再生**でき（Decision Replay）、自身の意思決定から**学習**できる（OS Policy Learning）— Transformer の事前学習とは別軸の学習です。

## ライセンス
MIT — `LICENSE` を参照。
