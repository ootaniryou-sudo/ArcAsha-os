# ArcAsha (Akasha-OS)

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
| **AVM** | AI Virtual Memory — context as demand-paged virtual memory (real-API validated on long-context docs: **96.5% token reduction at 100% accuracy** — the legacy 4.10x / −77% figure is a **pre-separation** measurement) |
| **Executive / Meta Executive** | Commands the search; learns its own policy from observed outcomes |
| **Expert Evolution** | Experts split / merge / retire by objective criteria (health, overlap, utilization) |
| **Thinking Modes** | Fast / Auto / Deep / Custom — same OS, different pipeline |
| **Explainable** | **Decision Explanation** (why this configuration), **Decision Replay** (step-by-step), **OS Policy Learning** (decisions become training data) |
| **Validation** | Simulation vs Real Device separated; external benchmarks: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench (the Qwen1.5B rows are **pre-separation** simulation; real-API validation → see Phase 4 below) |

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
npm run selftest        # AILSM 89 deterministic tests
npm run benchmark       # full benchmark + reports/ (json/csv/md)
npm run arcasha -- benchmark
```

Or work directly in the core package:

```bash
cd akasha-master
npm install
npm run ailsm:selftest    # 89 deterministic tests
npx tsx examples/quickstart.ts   # 5-minute tour
```

---

## 💬 AI Assistant（リッチな Chat WebUI・長期記憶つき）

専門知識なしの一般ユーザーが日常タスクにすぐ使える **AI アシスタント**です
（DeepSeek Web UI 風のリッチな画面・依存ゼロ）。複数モデル（`deepseek-v4-flash` /
`deepseek-v4-pro`）をタスク分類で自動ルーティングし、**長期記憶**（ユーザーについて・
好み・会話スレッド）を JSON に永続化します（再起動後も記憶は残ります）。

```bash
cd akasha-master
npm run assistant          # http://localhost:4781 で起動
npm run assistant:test     # 長期記憶 + 記憶抽出ルールのユニットテスト (21 tests)
```

- **AI Coding Agent（Workspace Write）**: コンポーザー左下の Access mode を
  `Workspace Write` に切り替えると、Chat から指示するだけで **実ファイルを編集**します。
  SWE エージェント（`src/arcasha/swe/`）のツールループをエンジンに使い、ツール呼び出し・
  思考（Thought for a while）・Trajectory（実行ログ）をストリーミング表示
- **多言語エンドポイント**: `/ja` `/en` `/zh` `/ko` で Chat 画面の言語を切替
  （`/` は設定タブで保存した言語が既定）。バナーの 🌐 チップからも切替可能
- **設定タブ**: 使用する API（キー / Base URL）を Web から入力可能（.env より優先）。
  モデル選択は「その他」から自分でモデル名を入力できる。保存先は
  `~/.arcasha/assistant-settings.json`（git 管理外・API キーはマスク表示）
- **オーケストレーション制御**: 参加モデル数（1〜4）をスライダーで制御。
  1 = Flash のみ / 2 = Flash + Pro（既定）/ 3〜4 = 推論ノードを増やして
  フォールバックチェーンを拡張（空応答時に次のモデルへ委譲）
- **ハイパー Thinking モード**: `thinking` 有効 + `reasoning_effort=max` + 出力上限
  8000 トークン。深い推論向け（content が空でも推論内容を回答として採用）
- **AILSM 出力ビューア**: Chat の各回答に「⚙ AILSM 出力」ボタンが付き、自然言語入力が
  コンパイルされた **AILSA 命令列・検証結果・バイト列（hex）** を確認できます。
  スレッドへ保存されるため、**既に終わった Chat を開いても表示可能**
- **AILSM 指示語辞典タブ**: `registry.json`（唯一の権威）をカテゴリ別・検索付きで表示
- **スラッシュコマンド**: `/help` `/memory` `/remember` `/forget` `/pin` `/new` 等
- **OpenAI 互換 API**: `POST /v1/chat/completions`（baseURL = `http://localhost:4781/v1`）
  を Cursor 等の外部ツールからそのまま利用可能。`/v1/models` で利用モデルを公開
- **長期記憶の保存先**: `~/.arcasha/assistant-memory.json`（`ARCASHA_MEMORY_DIR` で変更可）
- 実装: `src/arcasha/assistant/`（server / settings / long-term-memory / remember / ui.html）

> 既存の AVM 可視化付きチャット（`npm run chat`・ポート 4780）はそのまま利用できます。

---

## 📁 Repository Layout

```
akasha-master/        Core implementation (TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments)
akasha-link/          Project A: Akasha-Link (distributed inference / tensor transport)
  ├── client-web/     Web client (WebGPU inference)
  └── kernel-native/  Native kernel prototype (Rust)
examples/             Attachment examples (code / math)
.github/              Issue templates + CI workflow
AI_*.md               Specifications (see below)
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

## 📊 Phase 4 — Real-API Validation

Phase 4 validates each component with **real API calls** (`deepseek-v4-flash`, measured, no fabricated numbers), comparing configurations on the same tasks and model. Full data: `reports/ablation/`.

### Component ablation (50 tasks × 3 runs)

| Config | Accuracy | Avg latency | Avg tokens |
|---|---|---|---|
| ① Baseline LLM | 98% | 1297ms | 161 |
| ② +AVM | 99% | 1256ms | 186 |
| ③ +Executive | 98% | 1334ms | 163 |
| ④ Full ArcAsha | 100% | 1442ms | 187 |

- AVM ON vs OFF significance via **McNemar** test (discordant b=2 / c=0, two-sided p=0.50 — no significant difference, and no regression)
- Per-task detail: `reports/ablation/ablation.md` (authoritative). `reports/ablation/ablation-quick.md` is a **pre-separation** quick measurement (12 tasks)

### Long-context AVM (12,668 chars / 396 pages)

| Config | Accuracy | Avg input tokens |
|---|---|---|
| Model alone (no doc) | 0% | 98 |
| AVM OFF (full context) | 100% | 8382 |
| AVM ON (relevant pages only) | 100% | **290** |

- **96.5% token reduction / 94.7% cost reduction** at 100% accuracy (page supply 39/396 = 9.8%)
- Boundary-crossing search misses fixed by **page overlap (slide window)**; search precision improved by **IDF weighting** (`reports/ablation-long/`)

### Executive bottleneck (50 tasks)

- Measurement exposed a **double model-call bug** under `forceDelegate` (12% of tasks made a second empty/duplicate call) → fixed
- After fix: every task calls the model exactly once; Executive latency delta **+348ms → +37ms** (+348ms = pre-fix delta measured in PR #37; +37ms matches the ablation table: ③+Executive 1334ms − ①Baseline 1297ms); TS-side overhead ≈ 0.2ms (`reports/ablation-exec/`)

## 🤖 SWE-bench Real-Problem Validation (coding agent)

Following Phase 4, ArcAsha's **software-engineering agent** (`src/arcasha/swe/`, tool-loop implementation) solved real instances from SWE-bench Lite. All numbers are measured via the real API — nothing fabricated.

### Experimental conditions

- **Instances**: 3 tasks selected from `princeton-nlp/SWE-bench_Lite` (test split, 300 tasks), all from **sympy/sympy** (pure-Python, zero-dependency, thus evaluable in our harness)
  - `sympy__sympy-24213` — dimension-equivalence check in `UnitSystem._collect_factor_and_dimension()` (2022-11)
  - `sympy__sympy-23117` — `sympy.Array([])` empty-array failure (2022-02)
  - `sympy__sympy-24152` — incomplete `TensorProduct.expand()` (2022-10)
- **Model**: `deepseek-v4-flash` (real API, `temperature=0`)
- **Environment**: macOS / Python 3.13.2 / pytest 9.1.1 / sympy editable-installed at its base_commit
- **Agent settings**: tool loop `maxIterations=50`; tools = list_dir / read_file / grep_search / glob_search / write_file / edit_file / run_command (test execution allowed). **Writing to test files (`tests/`, `test_*.py`, etc.) is forbidden** (SWE-bench applies the gold `test_patch` automatically at evaluation time)
- **Evaluation**: checkout `base_commit` → agent edits **source only** → reset the worktree → apply gold `test_patch` → apply agent patch → run `FAIL_TO_PASS` / `PASS_TO_PASS` via pytest → resolved iff all F2P pass. Function-name-only tests (sympy/django convention) are auto-resolved to node ids (`file::func`) by searching the repo

### Results (3/3 = 100%)

| instance_id | resolved | model calls | tool calls | time | patch |
|---|---|---|---|---|---|
| `sympy__sympy-24213` | ✅ | 26 | 31 | 93s | 717 B |
| `sympy__sympy-23117` | ✅ | 29 | 44 | 206s | 1,813 B |
| `sympy__sympy-24152` | ✅ | 11 | 13 | 71s | 930 B |

- **Resolve rate 3/3 (100%)**. All F2P tests and P2P regression tests pass
- The agent edits source via `edit_file`/`write_file` and verifies by running pytest via `run_command`
- **Honest caveats**:
  - LLM output is stochastic, so results vary run to run (e.g. `23117` failed once with "incomplete reply" and resolved on retry; `22005` was excluded as not evaluable — its 2021 base_commit is incompatible with Python 3.13, which removed `distutils`)
  - With only 3 selected tasks (selection bias), this 100% is **not** a statistical estimate of resolve rate
  - **Token usage was not measured in this run** (before usage aggregation existed). Token accounting (`promptTokens` / `completionTokens` / `totalTokens`) is now added in `agent.ts` / `eval.ts`, so future runs will record it in `reports/swebench/swebench-results.json`
- Evaluation harness (code): `src/arcasha/swe/`; committed results: `reports/swebench/swebench-results.json`

### Plain DeepSeek vs arcasha (1-instance controlled comparison, 2026-09)

To quantify what the agent/tool layer adds over a **plain model call**, we ran a controlled comparison on the **same single instance** (`sympy__sympy-24213`) between:

- **Plain DeepSeek** — a raw `deepseek-v4-flash` call (thinking mode ON, `reasoning_effort=high`) given the issue text **plus the target-file excerpt**, asked to hand-write a unified diff in one shot. 3 trials.
- **arcasha** — the full SWE agent (tool loop) as described above.

All numbers are real API measurements; cost uses DeepSeek's official `deepseek-v4-flash` pricing (off-peak: input $0.22 / output $0.66 per 1M tokens). Details & raw data: `reports/swebench/compare-deepseek-vs-arcasha.{md,json}`.

| metric | plain DeepSeek (3 trials) | arcasha |
|---|---:|---:|
| resolved | ❌ 0/3 | ✅ 1/1 |
| prompt tokens | 3,756 | 726,877 |
| completion tokens | 39,428 | 14,532 |
| total tokens | 43,184 | 741,409 |
| time | 267 s (3 trials) | 127 s |
| cost (off-peak, $) | $0.027 | $0.170 |

**Key finding**: the plain model *did* identify the correct fix in every trial — its proposed change was identical to the gold patch (`equivalent_dims` check) — but it **hand-writes unified diff syntax**, and in all 3 trials the hunk header line-counts were wrong / context was truncated, so `git apply` rejected the patch (0/3). The agent edits source files **directly** via `edit_file`/`write_file`, so the diff is generated by git itself (no hand-written hunk math) → always applicable → resolved. In short, solving SWE-bench needs not just "knowing the fix" but a **tool to apply it to real files**.

- Honest caveats: stochastic (a separate single-trial run did resolve 1/1; success is possible but unreliable for one-shot diff generation); 1 instance is not a statistical estimate.

---

## 🧪 Status

- **v1.0 released** — AI OS first generation (Phases 0-4: ISA/IR/Kernel/AVM → Realtime devices → Reasoning → Executive/Meta → Attachments → Validation)
- **v1.1** — Decision Replay, Real Device benchmark plan (Mac / iPhone 15 Pro / iPad M4)
- **Phase 4 real-API validation (2026-09)** — component ablation (Baseline/AVM/Executive/Full, 50 tasks × 3) + long-context AVM (96.5% token reduction at 100%) + Executive bottleneck (double-call bug fixed: +348ms → +37ms)
- **SWE-bench real-problem validation (2026-09)** — SWE-bench coding agent solved 3 selected sympy instances from SWE-bench Lite: **3/3 resolved (100%)** (deepseek-v4-flash; 11-29 model calls / 71-206s per instance)
- selftest [1]-[89] all pass / golden 30 / AILSA selftest / build + dist verified

---

## 🔬 Research Positioning

ArcAsha is **not** "a bigger model". It is:

> **An experimental platform to compose, control, and measure AI intelligence at the OS level — reproducibly.**

The most novel point: the OS can **explain why** Reflection / Planning / Debate were used (Decision Explanation), replay the whole decision process (Decision Replay), and **learn from its own decisions** (OS Policy Learning) — a training axis orthogonal to Transformer pretraining.

## License
MIT — see `LICENSE`.
