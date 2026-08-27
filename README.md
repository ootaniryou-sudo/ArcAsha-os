# ArcAsha (Akasha-OS)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21755612.svg)](https://doi.org/10.5281/zenodo.21755612)
> **An AI Operating System for Modular Reasoning and Runtime Intelligence**

ArcAsha is **not a model**. It is an **operating system that runs on top of neural models** — it configures, controls, measures, and **explains** AI reasoning at the OS level.

- We do **not** modify the model.
- We place an **OS layer outside the model** to manage intelligence: routing, memory, reasoning, scheduling, and self-improvement.

> **Core research question**: Can we compose, control, and measure intelligence at the OS level — and prove it reproducibly — rather than scaling the model alone?

---

## 🎯 Why ArcAsha

Models (GPT / MoE) perform all reasoning **inside** the neural network — a black box.

ArcAsha moves reasoning **outside** the model:

```
Task → Compiler → AILSM IR → Kernel → Executive → Hypothesis → Search → Experts → Memory
```

- **AILSM / AILSA**: AI-specific IR & ISA (the "machine code" of reasoning)
- **AVM**: AI Virtual Memory (only the needed context is loaded, like demand paging)
- **Executive / Meta Executive**: who commands the whole reasoning process
- **Intelligence Attachments**: advanced intelligence loaded only when needed (like optional kernel modules)

---

## 🏗️ Architecture (3 Layers)

```
Layer 3  Intelligence Attachments
         Reflection / Debate / Planning / Search / Creativity / Simulation / Coding
Layer 2  Executive Runtime
         Executive / Meta Executive / Expert Evolution / Intelligence Scheduler
Layer 1  Fast Runtime
         Kernel / AVM / Expert Runtime / ODAR / Device Tree   ← realtime, always fast
```

- **Fast vs Deliberation**: Fast keeps realtime control (robot: 30.3 fps), Deliberation loads only when needed (research / long reasoning).

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| **AVM** | AI Virtual Memory — context as demand-paged virtual memory (4.10x, −77% tokens vs full-context) |
| **Executive / Meta Executive** | Commands the search; learns its own policy from observed outcomes |
| **Expert Evolution** | Experts split / merge / retire by objective criteria (health, overlap, utilization) |
| **Thinking Modes** | Fast / Auto / Deep / Custom — same OS, different pipeline |
| **Explainable** | **Decision Explanation** (why this configuration), **Decision Replay** (step-by-step), **OS Policy Learning** (decisions become training data) |
| **Validation** | Simulation vs Real Device separated; external benchmarks: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench |

---

## 🚀 Quickstart

```bash
# Install (after publishing) or run from repo
npm install arcasha

# Full benchmark suite (Simulation) + Decision Explanation + Real Device plan + reports/
arcasha benchmark

# "Why did the AI choose this?" — replay the decision process step by step
arcasha replay

# OS Policy Learning — decisions become training data for the Meta Executive
arcasha policy
```

Or run from the repo (workspace root — convenience scripts delegate to the core package):

```bash
npm run setup           # npm install --prefix akasha-master
npm run selftest        # AILSM 72 deterministic tests
npm run benchmark       # full benchmark + reports/ (json/csv/md)
npm run arcasha -- benchmark
```

Or work directly in the core package:

```bash
cd akasha-master
npm install
npm run ailsm:selftest    # 72 deterministic tests
npx tsx examples/quickstart.ts   # 5-minute tour
```

---

## 🧩 Two Projects

This repository hosts **two independent projects** (boundaries clarified, git split pending):

| Project | Directory | Role |
|---|---|---|
| **Akasha-Link** | `akasha-link/` | **分散推論** — edge (WebGPU) distributed inference / tensor transport engine. Zero-copy binary relay, WebGPU overhead reduction, 5G/Wi-Fi compression. No cognition. |
| **ArcAsha-Core / MetaOS** | `akasha-master/` | **AI オーケストラ（異モデル AI 分散 MoE）** — model-agnostic orchestration OS layer. Thinking modes, AVM paging, harnesses, Caravan cognitive loop. Any backend (MLX / OpenAI / Anthropic / WebGPU) is connectable. |

They communicate only via the wire contract `akasha-link/PROTOCOL.md`.

---

## 📁 Repository Layout

```
akasha-master/        Project B: ArcAsha-Core / MetaOS (TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments / Caravan)
akasha-link/          Project A: Akasha-Link (distributed inference / tensor transport)
  ├── client-web/     Web client (WebGPU inference)
  ├── kernel-native/  Native kernel prototype (Rust: GPU compute / QUIC / TCP / memory pool)
  └── PROTOCOL.md     Akasha Wire Protocol (48B header + f32[] payload — the shared contract)
examples/             Attachment examples (code / math)
.github/              Issue templates + CI workflow
AI_*.md               Specifications (ArcAsha-Core, see below)
```

---

## 📚 Documentation

| Doc | Contents |
|-----|----------|
| `MASTER_SPEC.md` | Full architecture vision |
| `ARCASHA_V2_SPEC.md` | v2 design spec (v0.36) |
| `AI_REASONING.md` | Hypothesis SSA / Reasoning Graph / Executive / Meta Executive / Expert Evolution |
| `ARCHITECTURE.md` | 全体アーキテクチャ（Linux との対比 / 3 層 + メモリ / 研究ロードマップ） |
| `AI_COGNITIVE.md` | Composable Intelligence Runtime（タスクごとの動的配線 / 共有メモリ + IR / Team Learning / Knowledge Oasis） |
| `AI_IR_MODEL.md` | IR とモデルの関係（IR は OS の内部バス / モデルは IR を知らない / 蒸留・IR ネイティブ化） |
| `AI_ATTACHMENTS.md` | Attachment plugin layer / Thinking Modes |
| `AI_VALIDATION.md` | Scientific validation (Simulation vs Real Device) / Decision Explanation / Replay / Policy Learning |
| `AI_VIRTUAL_MEMORY.md` | AVM |
| `PAPER_OUTLINE.md` | Paper: "ArcAsha: An Explainable Runtime for AI Intelligence" |
| `CHANGELOG.md` | Release history (v1.0 / v1.1) |

---

## 🧪 Status

- **v1.0 released** — AI OS first generation (Phases 0-4: ISA/IR/Kernel/AVM → Realtime devices → Reasoning → Executive/Meta → Attachments → Validation)
- **v1.1** — Decision Replay, Real Device benchmark plan (Mac / iPhone 15 Pro / iPad M4)
- selftest [1]-[72] all pass / golden 30 / AILSA selftest / build + dist verified

---

## 🔬 Research Positioning

ArcAsha is **not** "a bigger model". It is:

> **An experimental platform to compose, control, and measure AI intelligence at the OS level — reproducibly.**

The most novel point: the OS can **explain why** Reflection / Planning / Debate were used (Decision Explanation), replay the whole decision process (Decision Replay), and **learn from its own decisions** (OS Policy Learning) — a training axis orthogonal to Transformer pretraining.

## License
MIT — see `LICENSE`.
