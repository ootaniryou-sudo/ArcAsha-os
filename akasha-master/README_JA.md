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

- **AVM**: 仮想メモリとしての文脈管理（全読込み比 4.10x・トークン −77%）
- **Executive / Meta Executive**: 探索を指揮し、観測結果から自身のポリシーを学習
- **Expert Evolution**: Expert が客観的基準（健康度・機能重複・利用率）で分裂・統合・引退
- **Thinking Modes**: Fast / Auto / Deep / Custom — 同じ OS でパイプラインを変更
- **Explainable**: **Decision Explanation**（なぜこの構成か）/ **Decision Replay**（ステップ再生）/ **OS Policy Learning**（意思決定を学習データに）
- **Validation**: Simulation と Real Device を分離。外部ベンチ: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench

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

## 🧪 ステータス

- **v1.0 リリース済み** — AI OS 第一世代（ISA/IR/Kernel/AVM → 実機 → Reasoning → Executive/Meta → Attachments → Validation）
- **v1.1** — Decision Replay、実機ベンチプラン（Mac / iPhone 15 Pro / iPad M4）
- selftest [1]-[89] 全パス / golden 30 / AILSA selftest / build + dist 検証済み

## 🔬 研究上の位置付け

ArcAsha は「より大きなモデル」ではありません：

> **AI の知能を OS レベルで構成・制御・計測できる、再現可能な実験基盤。**

最も新しい点: OS が「なぜ Reflection / Planning / Debate を使ったのか」を**説明**でき（Decision Explanation）、意思決定プロセス全体を**再生**でき（Decision Replay）、自身の意思決定から**学習**できる（OS Policy Learning）— Transformer の事前学習とは別軸の学習です。

## ライセンス
MIT — `LICENSE` を参照。
