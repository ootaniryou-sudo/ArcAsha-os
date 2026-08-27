# ArcAsha Naming System v2

> Akasha-OS の全コンポーネントに与えられた世界観名（Lore Name）と正式名称（Formal Name）の対応表。
> コードでは英語 identifier を使用し、JSDoc に世界観名を併記する。
>
> **v1.0 以降の扱い**: 旧 v1 の世界観名（Heart of Wisdom / Eye of Wisdom / Shadow of Wisdom など）は
> レガシー（lore）として下記に残す。新システム（Executive / Attachments / Decision）の命名は
> 「[Reasoning / Executive](#reasoning--executive-v10)」「[Attachments](#attachments-v10)」セクションを参照。

## Core / Central System

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Heart of Wisdom** | Core Orchestrator | `src/core/orchestrator.ts`, `src/core/router.ts` |
| **Wisdom Core** | Global Control Plane | `src/index.ts` (エントリポイント) |
| **Edict Engine** | System Governance | ポリシー・権限制御（将来） |

## Client / Terminal

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Akasha Terminal** | AI Client | `akasha-link/client-web/` |
| **Knowledge Gateway** | Client Gateway | `src/client/node-client.ts` |
| **Consciousness Window** | Session Interface | `src/core/inference-loop.ts` |

## Routing / Scheduling

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Eye of Wisdom** | Intelligent Router | `src/core/router.ts`, `src/fault/fault-tolerance.ts` |
| **Mandate Weaver** | Task Scheduler | `src/core/shard-allocator.ts` |
| **Knowledge Constellation** | Load Balancer | `src/structures/idle-cluster-pool.ts` |
| **Path Oracle** | Route Selector | `src/core/inference-loop.ts` (pickNode) |
| **Numerical Stability** | Backend Precision Reliability | Router score dimension — backend + precision divergence risk (EXP-0001.5/1.6/1.7) |

## Node / Cluster

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Knowledge Node** | Inference Node | `src/client/node-client.ts` |
| **Edge Terminal** | Lightweight Edge Node | `akasha-link/client-web/src/worker.ts` |
| **Core Terminal** | High-Performance Node | `akasha-link/kernel-native/` |
| **Guardian Terminal** | Replica / Backup Node | `src/fault/fault-tolerance.ts` (shadow) |
| **Star Registry** | Node Registry | `src/structures/idle-cluster-pool.ts` |
| **Star Pulse** | Node Health Monitor | `src/core/cluster-guardian.ts` (NicMonitor) |

## Communication

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Knowledge Edict** | Binary Wire Protocol | `src/binary/protocol.ts` |
| **Starway** | Transport Layer | `src/net/` (Rust), `src/workers/network-worker.ts` |
| **Knowledge Bridge** | Relay Layer | `src/core/inference-loop.ts` (forwardToBand) |
| **Pulse Signal** | Heartbeat | `Cmd.HEARTBEAT` in `src/binary/protocol.ts` |

## Fault Tolerance

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Shadow of Wisdom** | Shadow Execution | `src/fault/fault-tolerance.ts` |
| **Exact Shadow** | Same-backend Shadow (token identity) | `src/fault/fault-tolerance.ts` — same model + backend + precision → exact token reproduction |
| **Independent Shadow** | Cross-backend Shadow (semantic verification) | `src/fault/fault-tolerance.ts` — different backend → Verifier → accept/reject |
| **Shadow Ascension** | Shadow Promotion | `FaultToleranceEngine.scan()` |
| **Divine Safeguard** | Fault Protection | `src/fault/fault-tolerance.ts` |
| **Second Awakening** | Recovery / Retry | `src/core/inference-loop.ts` (retry) |
| **Last Sanctuary** | Emergency Fallback | `src/core/cluster-guardian.ts` (EmergencyDisconnect) |

## Memory

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Realm of Knowledge** | Memory Fabric | `src/memory/store.ts` |
| **Chronicle** | Conversation Store | `InMemoryConversationStore` |
| **Recall Engine** | Semantic Memory / Retrieval | `MemoryRetriever` interface |
| **Memory Shard** | Memory Chunk | `SearchMemory` type |
| **Memory Page** | Context Page | `ContextManager` in `src/memory/context.ts` |
| **Memory Passage** | Context Paging | `ContextManager.truncate()`, tier management |
| **Echo** | Runtime KV Cache | `KVCachePage`, `PrefixCache` |
| **Echo Prime** | Prefix KV Cache | `InMemoryPrefixCache` |
| **Deep Archive** | Cold Context Storage | `PageTier.COLD` |

## Long Context

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Endless Knowledge** | Long-Context Engine | `ContextManager` (page-based) |
| **Millionfold Context** | 1M-Context Mode | 将来目標（段階的: 4K→8K→32K→128K→256K→1M） |
| **Near Memory** | Hot Context Layer | `PageTier.HOT` |
| **Mid Memory** | Warm Context Layer | `PageTier.WARM` |
| **Far Memory** | Cold Context Layer | `PageTier.COLD` |

## Model Runtime

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Wisdom Engine** | LLM Runtime | `src/llm/adapter.ts` (LLMAdapter) |
| **Invocation Forge** | Model Loader | `LLMAdapter.loadModel()` |
| **Knowledge Core** | Model Core | `ModelMetadata` |
| **Transmutation** | Model Quantization | `training/quantize.py` |
| **Resonance Compression** | Activation Compression | 将来実装（Feature Flag） |
| **Adaptive Resonance** | Adaptive Activation Precision | 将来実装 |
| **Future Sight** | Speculative Decoding | `src/core/inference-loop.ts` (speculative path), 将来実装 |

## Apple Backend

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Asha Metal** | Metal/MPS Inference Backend | 将来実装 — Qwen3-0.6B on iPhone GPU via Metal Performance Shaders |
| **Asha Neural** | Core ML / Core AI Backend | 将来実装 — Apple Neural Engine + CPU + GPU orchestration |
| **Asha Metal Kernel Lab** | Custom Metal Shader Research | 将来実装 — Custom attention, KV cache, quantized matmul in Metal |

## Reasoning / Executive（v1.0+）

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Command Deck** | Executive Runtime | `src/arcasha/ailsm/executive-runtime.ts` |
| **Conductor** | Executive | `src/arcasha/ailsm/executive.ts`（task manages executive / executive manages process） |
| **Strategist** | Meta Executive | `src/arcasha/ailsm/meta-executive.ts` |
| **Metamorphosis** | Expert Evolution | `src/arcasha/ailsm/expert-evolution.ts`（split / merge / retire） |
| **Reasoning Graph** | Reasoning Graph Runtime | `src/arcasha/ailsm/reasoning.ts`（SPAWN → EVALUATE → REFLECT） |
| **Tempo** | Thinking Modes | `src/arcasha/attachments/modes.ts`（Fast / Auto / Deep / Custom） |
| **Intelligence Scheduler** | Thinking Budget Allocator | `modes.ts`（intelligenceScheduler, usedMs ≤ budgetMs） |
| **Verdict** | Decision Explanation | `src/arcasha/attachments/explain.ts` |
| **Retrospect** | Decision Replay | `src/arcasha/attachments/replay.ts` |
| **Mentorship** | OS Policy Learning | `src/arcasha/attachments/decision-log.ts` |

## Attachments（v1.0+）

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Facet** | Attachment | `src/arcasha/attachments/attachment.ts` |
| **Facet Forge** | Attachment Manager | `src/arcasha/attachments/manager.ts` |
| **Mirror** | Reflection | `attachments/reflection.ts` |
| **Symposium** | Debate | `attachments/debate.ts` |
| **Blueprint** | Planning | `attachments/planning.ts` |
| **Expedition** | Search | `attachments/search-attachment.ts` |
| **Genesis** | Creativity | `attachments/creativity.ts` |
| **Simulacrum** | Simulation | `attachments/simulation.ts` |
| **Anvil** | Coding | `attachments/coding.ts` |

## MoE / Specialist（Legacy v1）

> `src/plugin/`（AkashaExpertPlugin / PluginRegistry）は v1.0 で廃止され、
> 新 Attachment 層（`src/arcasha/attachments/`）+ Executive に置き換えられた。

| 世界観名 | 正式名称 | コード上の主な該当箇所 |
|---------|---------|---------------------|
| **Constellation Mind** | Distributed Mixture-of-Experts | 将来実装（Phase 8） |
| **Specialist Core** | Expert Model | （廃止 → Attachment を参照） |
| **Constellation Router** | Expert Router | （廃止 → Executive / AttachmentScheduler を参照） |
| **Core Migration** | Expert Migration | 将来実装 |

## Recommended Core Set（Legacy v1）

```
ArcAsha
├── Heart of Wisdom     (Core Orchestrator)      [Legacy]
├── Eye of Wisdom       (Intelligent Router)     [Legacy]
├── Mandate Weaver      (Task Scheduler)
├── Star Registry       (Node Registry)
├── Knowledge Edict     (Binary Wire Protocol)
├── Realm of Knowledge  (Memory Fabric)
├── Endless Knowledge   (Long-Context Engine)
├── Echo                (Runtime KV Cache)
├── Shadow of Wisdom    (Shadow Execution)
├── Divine Safeguard    (Fault Protection)
├── Wisdom Engine       (LLM Runtime)
├── Constellation Mind  (Distributed MoE)
├── Future Sight        (Speculative Decoding)
├── Asha Metal          (Metal/MPS Backend)
└── Asha Neural         (Core ML/Core AI Backend)
```

### v1.0+ Reasoning Set

```
ArcAsha (AI OS)
├── Core                (Kernel / AVM)
├── Thought Graph       (AILSM IR)
├── Command Deck        (Executive Runtime)
│   ├── Conductor       (Executive)
│   ├── Strategist      (Meta Executive)
│   └── Metamorphosis   (Expert Evolution)
├── Tempo               (Thinking Modes)
├── Facet               (Attachment)
│   ├── Mirror          (Reflection)
│   ├── Symposium       (Debate)
│   ├── Blueprint       (Planning)
│   ├── Expedition      (Search)
│   ├── Genesis         (Creativity)
│   ├── Simulacrum      (Simulation)
│   └── Anvil           (Coding)
├── Verdict             (Decision Explanation)
├── Retrospect          (Decision Replay)
└── Mentorship          (OS Policy Learning)
```

## Naming Rule

- すべての世界観名には、初出時に必ず正式名称を併記する
- 例: **Conductor (Executive)** / **Facet (Attachment)**
- 以後の文章では必要に応じて短縮名を使用する
- 旧 v1 の世界観名（Heart of Wisdom 等）はレガシーとして、新規記述では使用しない
- コードでは英語 identifier を使用し、JSDoc に世界観名を付与する

```typescript
/**
 * Conductor (Executive)
 *
 * 探索を指揮し、戦略を途中で切り替える。
 * Expert の選択・評価・統合を管理する。
 */
export class Executive { ... }
```
