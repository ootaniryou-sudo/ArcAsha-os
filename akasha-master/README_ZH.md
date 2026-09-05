# ArcAsha（Akasha-OS）

> **面向 AI 的操作系统 — 模块化推理与运行时智能**

ArcAsha **不是模型**。它是运行在神经网络模型**之上的操作系统** — 在 OS 层面**配置、控制、测量、解释** AI 推理。

- 我们**不修改**模型。
- 我们在模型**外部**放置 OS 层，管理路由、内存、推理、调度与自我改进。

> **核心研究问题**：能否不扩大模型，而是在 OS 层面组合、控制、测量智能，并以可复现的方式证明它？

---

## 🎯 为什么是 ArcAsha

GPT / MoE 在神经网络**内部**（黑盒）完成所有推理。

ArcAsha 将推理移到模型**外部**：

```
Task → Compiler → AILSM IR → Kernel → Executive → Hypothesis → Search → Experts → Memory
```

- **AILSM / AILSA**：AI 专用的中间表示与指令集
- **AVM**：AI 虚拟内存（仅按需加载所需上下文）
- **Executive / Meta Executive**：指挥整个推理，并从观测中学习自身策略
- **Intelligence Attachments**：仅在需要时加载的高级智能（类似可选内核模块）

---

## 🏗️ 三层架构

```
Layer 3  Intelligence Attachments（Reflection / Debate / Planning / Search / Creativity / Simulation / Coding）
Layer 2  Executive Runtime（Executive / Meta Executive / Expert Evolution / Intelligence Scheduler）
Layer 1  Fast Runtime（Kernel / AVM / Expert Runtime / ODAR / Device Tree）— 始终高速
```

**Fast 与 Deliberation 分离**：Fast 保持实时控制（机器人 30.3fps），Deliberation 仅在需要时加载（研究 / 长时推理）。

## ✨ 主要特性

- **AVM**：上下文作为按需分页的虚拟内存（实 API 验证・长文场景：Token 减少 96.5%、准确率 100% — 旧 4.10x / −77% 为**分离前**测量）
- **Executive / Meta Executive**：指挥搜索，从结果中学习策略
- **Expert Evolution**：专家按客观标准（健康度 / 重叠 / 利用率）分裂、合并、退休
- **Thinking Modes**：Fast / Auto / Deep / Custom — 同一 OS，不同管线
- **可解释**：**Decision Explanation**（为什么这个配置）、**Decision Replay**（逐步回放）、**OS Policy Learning**（决策成为训练数据）
- **验证**：Simulation 与 Real Device 分离；外部基准：GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench（Qwen1.5B 行是**分离前** simulation 测量；实 API 验证见下方 Phase 4）

---

## 🚀 快速开始

```bash
npm install arcasha
arcasha benchmark   # 完整基准（Simulation）+ Decision Explanation + reports/
arcasha replay      # 「为什么得到这个回答」逐步回放
arcasha policy      # OS 策略学习演示
```

从仓库运行：

```bash
cd akasha-master
npm install
npm run ailsm:selftest          # 72 个确定性测试
npm run benchmark               # 完整基准 + reports/（json/csv/md）
npx tsx examples/quickstart.ts  # 5 分钟体验
```

---

## 💬 AI 助手（丰富的 Chat WebUI・带长期记忆）

无需专业知识、可立即用于日常任务的 **AI 助手**（类似 Hermes Agent / DeepSeek Web UI・零依赖）。
多模型（`deepseek-v4-flash` / `deepseek-v4-pro`）按任务自动路由，**长期记忆**（用户信息・喜好・
会话线程）以 JSON 持久化（重启后仍保留）。

```bash
cd akasha-master
npm run assistant          # 启动于 http://localhost:4781
npm run assistant:test     # 长期记忆 + 记忆提取规则单元测试（21 tests）
```

- **休闲模式（默认）**: 用自然语言处理日常任务（咨询・写作・摘要・点子等）。
  自我介绍（「我的名字是〜」「喜欢/讨厌〜」）会被自动记住并在之后活用
- **专家模式**: 右上角切换后可使用 `/help` `/memory` `/remember` `/forget` `/pin` 等斜杠命令
- **OpenAI 兼容 API**: `POST /v1/chat/completions`（baseURL = `http://localhost:4781/v1`）
  可直接从 Cursor 等外部工具使用。`/v1/models` 公开可用模型
- **长期记忆保存位置**: `~/.arcasha/assistant-memory.json`（可用 `ARCASHA_MEMORY_DIR` 修改）
- 实现: `src/arcasha/assistant/`（server / long-term-memory / remember / ui.html）

---

## 📁 仓库结构

```
akasha-master/        核心实现（TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments）
akasha-link/          Project A: Akasha-Link（分布式推理 / 张量传输）
  ├── client-web/     Web 客户端（WebGPU 推理）
  └── kernel-native/  原生内核原型（Rust）
examples/             插件示例（code / math）
AI_*.md               规范文档
```

## 📚 文档

`MASTER_SPEC.md`（整体愿景）/ `ARCASHA_V2_SPEC.md`（v2 设计 v0.36）/ `AI_REASONING.md`（推理运行时）/ `AI_ATTACHMENTS.md`（插件层）/ `AI_VALIDATION.md`（验证与解释）/ `AI_VIRTUAL_MEMORY.md`（AVM）/ `PAPER_OUTLINE.md`（论文）/ `CHANGELOG.md`（历史）

## 🤖 SWE-bench 实测问题验证（编码智能体）

Phase 4 之后，ArcAsha 的软件工程智能体（`src/arcasha/swe/`・工具循环实现）用真实 API 解决了 SWE-bench Lite 的实例。全部数字均为实测。

- **对象**: 从 `princeton-nlp/SWE-bench_Lite`（test split 300 题）选出 **sympy/sympy 的 3 题**（纯 Python・零依赖・可在本地评测）— `24213`（量纲等价判定）/ `23117`（`Array([])`）/ `24152`（`TensorProduct.expand`）
- **模型**: `deepseek-v4-flash`（真实 API・`temperature=0`）/ 环境: macOS / Python 3.13.2 / pytest 9.1.1 / sympy 在 base_commit 上 editable install
- **评测**: checkout `base_commit` → 智能体只改**源码** → 还原工作区 → 应用 gold `test_patch` → 应用智能体补丁 → 用 pytest 跑 `FAIL_TO_PASS`/`PASS_TO_PASS` → F2P 全部通过即 resolved。仅函数名（无路径）的测试会自动解析为 `文件::函数`
- **结果: 3/3 解决（100%）** — model calls 26/29/11・tools 31/44/13・93s/206s/71s（每题）
- 如实说明: LLM 有随机性（`23117` 曾因“不完整回复”失败，重跑后解决；`22005` 因 2021 版 base_commit 与 Python 3.13 的 `distutils` 移除不兼容而无法评测）；仅 3 道自选题，并非统计意义的解决率；**本次运行未记录 token 消耗**（`agent.ts`/`eval.ts` 已加入 usage 统计，后续运行会写入 `reports/swebench/swebench-results.json`）
- 评测框架（代码）: `src/arcasha/swe/`；已提交结果: `reports/swebench/swebench-results.json`

### 普通 DeepSeek vs arcasha（1 题・对照实验, 2026-09）

为量化智能体/工具层相对“裸模型调用”的价值，我们在**同一道题**（`sympy__sympy-24213`）
上对比了：

- **普通 DeepSeek** — 裸 `deepseek-v4-flash`（thinking ON・`reasoning_effort=high`），
  只给问题文本 **+ 目标文件摘录**，要求一次手写 unified diff。跑 3 次。
- **arcasha** — 上述 SWE 智能体（工具循环）原样。

数字均为真实 API 实测；费用按 DeepSeek 官方 `deepseek-v4-flash` 单价
（off-peak: 输入 $0.22 / 输出 $0.66 per 1M）估算。详情与原始数据:
`reports/swebench/compare-deepseek-vs-arcasha.{md,json}`。

| 指标 | 普通 DeepSeek（3 次） | arcasha |
|---|---:|---:|
| 解决 | ❌ 0/3 | ✅ 1/1 |
| 输入 token | 3,756 | 726,877 |
| 输出 token | 39,428 | 14,532 |
| 总 token | 43,184 | 741,409 |
| 时间 | 267 s（3 次合计） | 127 s |
| 费用（off-peak, $） | $0.027 | $0.170 |

**关键发现**: 普通 DeepSeek 每次都找对了修复内容（与 gold 补丁一致，`equivalent_dims`
检查）。但它要**手写** unified diff，3 次都出现 hunk 头行数算错/末尾上下文缺失，
`git apply` 全部拒绝（0/3）。智能体用 `edit_file`/`write_file` **直接改源码**，
diff 由 git 自己生成（无需手算 hunk）→ 永远可应用 → 解决。即：解 SWE-bench 不仅要
“知道怎么改”，还要有**把修改落到真实文件的工具**，这是本题对比的结论。

- 如实说明: 有随机性（另一次单次运行也确认过 1/1 解决；一次性 diff 生成可行但不稳定）・
  仅 1 题，非统计意义。

## 🧪 状态

- **v1.0 已发布** — AI OS 第一代（ISA/IR/Kernel/AVM → 实机 → Reasoning → Executive/Meta → Attachments → Validation）
- **v1.1** — Decision Replay、实机基准计划（Mac / iPhone 15 Pro / iPad M4）
- **Phase 4 实 API 验证（2026-09）** — 组件消融（Baseline/AVM/Executive/Full・50 题 × 3）+ 长文 AVM（96.5% Token 减少・准确率 100%）+ Executive 瓶颈（双重调用修复: +348ms → +37ms・PR #37 实测）
- selftest [1]-[72] 全通过 / golden 30 / AILSA selftest / build + dist 已验证

## 🔬 研究定位

ArcAsha 不是「更大的模型」：

> **在 OS 层面组合、控制、测量 AI 智能的可复现实验平台。**

最具新意之处：OS 能**解释**为什么使用 Reflection / Planning / Debate（Decision Explanation）、**回放**整个决策过程（Decision Replay）、并从自身决策中**学习**（OS Policy Learning）— 与 Transformer 预训练正交的学习轴。

## 许可证
MIT — 见 `LICENSE`。
