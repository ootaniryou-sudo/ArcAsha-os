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
