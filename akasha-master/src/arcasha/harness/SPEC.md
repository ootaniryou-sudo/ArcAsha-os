# ArcAsha Coding Harness 仕様書

**文書種別:** 設計仕様書・詳細仕様書
**対象:** ArcAsha Master Runtime の Coding Attachment / Harness Execution Layer
**対象フェーズ:** H0〜H3 を実装可能な最小仕様 + H4以降の拡張契約
**作成日:** 2026-08-20
**ステータス:** H0 実装済み（PR #15）→ H1/H2-A 実装済み（PR #16）→ H2-B 実装済み（PR #17）

---

## 1. 目的

本仕様は、ArcAsha の既存 `Coding Attachment` に対して、Agent Runtime を交換可能にする **Coding Harness Layer** を定義する。

最初の目標は H0〜H3 とし、次を満たす。

1. Coding Attachment が特定の Agent Runtime に依存しない。
2. 実行を Event Stream として観測できる。
3. Native Harness と DeepSeek Harness Adapter を同一 ABI で交換できる。
4. Task failure と Harness infrastructure failure を区別する。
5. `AbortSignal` を下位実行へ伝播できる。
6. H0〜H3 では Capability Resolver / Router / ODAR / Reasoning Search を導入せず、複雑性を閉じ込める。
7. H4 以降に AILSM / Cognitive Graph / Router と接続できる余地を残す。

---

## 2. 背景

ArcAsha の Attachment 層は高度な知能を Core から分離するプラグイン層として設計されている。Attachment は Kernel 状態を直接変更せず、Executive Runtime / AVM 経由で動作し、Attachment Manager が register/load/unload/enable/disable/execute/executeParallel/executeMerged を担当する。

現行 Coding Attachment は、仕様解析、アーキテクチャ理解、コード生成、自己レビュー、Node による構文チェック、リトライを一つの Attachment 内で処理している。

一方 DeepSeek Harness は Cordis 上でモデルアダプタ、Tool Registry、Session Log、Agent Loop などを plugin として構成し、イベントと capability seam を中心に実行を組み立てる。

本仕様では DeepSeek Harness を ArcAsha の直接依存にはせず、

```text
ArcAsha Harness ABI
        ↓
Native Harness / DeepSeek Harness Adapter
```

という Ports & Adapters 型の境界を導入する。

---

## 3. 設計原則

### 3.1 Coding Attachment は DeepSeek を知らない

禁止:

```ts
import { DeepSeekHarness } from "...";
```

許可:

```ts
import type { Harness } from "../harness/harness.js";
```

依存方向は常に、

```text
CodingAttachment
      ↓
Harness interface
      ↑
DeepSeekHarnessAdapter
```

とする。

### 3.2 Event Stream first

正式 ABI は `Promise<Result>` ではなく `AsyncIterable<HarnessEvent>`。

単発 API が必要なら Event Stream の上に `executeOnce()` を実装する。

### 3.3 Failure semantics を分離

```text
failed  ≠ throw
cancel  ≠ failed
detach  ≠ rollback
```

### 3.4 H0〜H3で意味論を統合しすぎない

AILSM capability、Router capability、Cognitive Graph capability を H0〜H3 で統合しない。

---

# 4. 現行 ArcAsha との接続

## 4.1 Attachment

現在の Attachment ABI は `run(context): Promise<AttachmentResult>` を中心に構成され、結果に `ok / text / quality / latencyMs / calls / tokens / detail` を持つ。

Harness 導入後も外側の Attachment API は原則維持する。

```text
Attachment
   ↓
Harness orchestration
   ↓
HarnessEvent stream
   ↓
AttachmentResult
```

## 4.2 Attachment Manager

Harness は AttachmentManager の代替ではない。

```text
Executive
  ↓
AttachmentManager
  ↓
CodingAttachment
  ↓
Harness
```

## 4.3 AILSM

現行 AILSM `NodeKind` には、`capability / execution / process / thread / context / hypothesis / executive / metaexecutive / expert` が存在する。

H0〜H3では Harness と直接結合しない。ただし将来、

```text
Harness execution → execution node
Required capability → capability node
Harness comparison → hypothesis node
```

と対応付けられる余地を残す。

## 4.4 Router

現行 Router は Expert 選択に `capability / latency / cost / stability / confidence / memory / temperature` を含む特徴量を利用する。

H0〜H3では Router の意味論を変更しない。将来 `Harness / Expert / Model / Capability Set` を含む構成探索へ拡張する。

---

# 5. 概念モデル

## 5.1 Task

論理的な仕事そのもの。

```text
taskId = "issue-123"
text   = "src/foo.ts のバグを修正してテストを通す"
```

Task は retry しても変わらない。

## 5.2 Execution

Task に対する 1 回の実行試行。

```text
taskId = issue-123

executionId
├── native-attempt-1
├── dsh-attempt-1
└── dsh-attempt-2
```

`executionId` は Harness が発行する。

## 5.3 Harness

Task を実行する実行基盤。

例: NativeHarness / DeepSeekHarnessAdapter / 将来の RemoteHarness / SandboxHarness

## 5.4 Harness Event

実行中に観測できる逐次イベント。

## 5.5 Capability

実行能力の意味的名称。H3では `code.execute` の 1 種類だけを扱う。

---

# 6. Harness ABI

```ts
export interface Harness {
  execute(
    task: HarnessTask,
    options?: HarnessExecuteOptions,
  ): AsyncIterable<HarnessEvent>;
}
```

`Promise<Result>` を基本 API にしない。

---

# 7. Task 型

```ts
export interface HarnessTask {
  taskId: string;                     // 論理タスクID。retryしても変化しない。caller 発行。
  text: string;                       // 実行対象のタスク文。
  metadata?: Record<string, unknown>; // H0では任意。将来拡張用。
}
```

`taskId` は caller が発行する。`executionId` と同一視してはならない。

---

# 8. Execution ID

`executionId` は Harness が発行する **1 回の実行試行単位の ID**。

```text
taskId     = 論理タスク
executionId = そのタスクの1回の実行
```

用途: retry 識別 / Native vs DSH 比較 / cancellation target / replay / 将来の ODAR observation / AILSM `execution` node 対応

---

# 9. Execute Options

```ts
export interface HarnessExecuteOptions {
  signal?: AbortSignal;
  cancelGracePeriodMs?: number;
}
```

## 9.1 Cancellation

`AbortSignal` は停止要求。

```text
AbortController.abort() → ArcAsha Harness → Adapter → Agent / Tool / subprocess
```

## 9.2 Grace Period

Abort 後、下位実行が停止しない場合に備えて finite な猶予時間を持つ。H0では具体値を ABI の絶対値として固定しない。

## 9.3 Detach

grace period 超過時、caller は execution を `detached` として扱える。**detached は副作用が存在しないことを意味しない。**

---

# 10. Event ABI

H0の最小 event set:

```ts
export type HarnessEvent =
  | HarnessStartedEvent
  | HarnessCompletedEvent
  | HarnessFailedEvent;
```

H2 以降で必要に応じて `progress / tool_call / tool_result / model_call / message / cancelled` を追加する。

---

# 11-13. 各 Event

## Started

```ts
interface HarnessStartedEvent {
  type: "started";
  taskId: string;
  executionId: string;
  timestamp: number;
}
```

## Completed

```ts
interface HarnessCompletedEvent {
  type: "completed";
  taskId: string;
  executionId: string;
  result: HarnessResult;
  timestamp: number;
}
```

`completed` 発行時点で `result` は有効な最終結果。

## Failed

```ts
interface HarnessFailedEvent {
  type: "failed";
  taskId: string;
  executionId: string;
  error: HarnessExecutionError;
  timestamp: number;
}
```

`failed` は **Harness Runtime は存続可能だが、その Task Execution が失敗した**状態。例: tool failure / test failure / code execution failure / agent が解決できない / sandbox 内失敗。上位は retry / fallback を判断してよい。

---

# 14. Iterator Throw

Iterator 自体が throw するのは **Harness / Adapter の継続不能障害**。例: Adapter 初期化失敗 / DSH プロセス起動不能 / 通信チャネル喪失 / ABI 不整合 / internal invariant violation。これは Task failure ではなく infrastructure failure。

---

# 15. Throw後の部分実行

```text
started → tool_call → tool_result → tool_call → (throw)
```

意味:

```text
execution state = incomplete / unknown
final result    = invalid
event history   = observational history
side effects    = may have occurred
rollback        = not guaranteed
```

H0〜H3では automatic resume / rollback は実装しない。**「結果を信用しない」と「副作用が無かった」は別。**

---

# 16. Cancellation

理想経路: `AbortSignal → graceful cancellation → Agent / Tool 停止 → terminal event`。H2では `cancelled` event を追加してもよい。grace period 超過時は detach / force cleanup。

---

# 17. HarnessResult

H0では AttachmentResult に直接依存させない。

```ts
export interface HarnessResult {
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}
```

上位で `HarnessResult → Coding Attachment → AttachmentResult` へ変換する。

---

# 18. HarnessExecutionError

```ts
export interface HarnessExecutionError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

最低限 `code / message / retryable` を持つ。

---

# 19. executeOnce

```ts
export async function executeOnce(harness, task, options?): Promise<HarnessResult> {
  for await (const event of harness.execute(task, options)) {
    if (event.type === "completed") return event.result;
    if (event.type === "failed") throw new Error(event.error.message);
  }
  throw new Error("Harness ended without terminal event");
}
```

実装では専用 exception 型へ変換してよい（H0 実装は `HarnessTaskError` へ変換）。

---

# 20-21. Native Harness

H1では既存 Coding の決定論的処理を `NativeHarness` に閉じ込める。DSH なしで ABI を検証する。

成功: `started → completed(result)` / Task failure: `started → failed(error)` / Infrastructure failure: `started → throw`

---

# 22. Coding Attachment の責務

```text
Coding Attachment
├── task preparation
├── capability declaration
├── Harness invocation
├── event consumption
└── AttachmentResult mapping
```

Agent Runtime の具体的な実行は Harness に委譲する。

---

# 23. `code.execute` Capability

H3で最初の Capability 名を固定: `code.execute`

> コード変更またはコード実行を含むソフトウェア工学上の実作業を、指定された実行環境で遂行する能力。

H3では Capability Resolver を導入しない。

---

# 24-26. DeepSeek Harness Adapter（H2）

`ArcAsha Harness ABI → DeepSeekHarnessAdapter → DeepSeek Harness`

Adapter の責務:
- ArcAsha `HarnessTask` → DSH Task/Session 変換
- `executionId` 追跡
- `AbortSignal` 伝播
- DSH event → ArcAsha event 変換
- DSH task failure → `failed`
- DSH infrastructure failure → iterator throw
- terminal state 保証
- cleanup / detach

DSH 固有型を ArcAsha 全体へ漏らさない。DSH Event API をそのまま ArcAsha ABI に公開しない。

---

# 27. DSH Revision Pinning

H2では upstream branch 追従を禁止。特定 commit SHA を記録し、integration test を SHA 単位で検証。更新は手動レビュー。`DSH_COMMIT=<verified-sha>`。固定 SHA → lockfile → CI cache / tarball → 必要性が高くなったら vendor mirror。いきなり全ソースを vendor しない。

---

# 28-31. 実装スコープ

| Phase | ディレクトリ / 内容 | 状態 |
|---|---|---|
| H0 | `akasha-master/src/arcasha/harness/` — types / events / harness / execute-once / consume / selftest | ✅ 済（PR #15） |
| H1 | `harness/native.ts` — 既存 Coding ロジックを NativeHarness 化 | ✅ 済（PR #16） |
| H2-A | `harness/deepseek.ts` — DSH adapter スケルトン（lockfile pin / プローブ / Native フォールバック） | ✅ 済（PR #16） |
| H2-B | ACP 接続による実実行（turn/step/tool → HarnessEvent 写像・AbortSignal 伝播） | ✅ 済（PR #17） |
| H3 | `CodingAttachment → code.execute → Harness → DSH/Native` | ⬜ 未着手 |

## H2-A 実装メモ（dsh 統合設計）

- dsh（@deepseek-ai/dsh）は **MIT**・Cordis ベースの「全員プラグイン」設計。
  **Developer preview（breaking changes あり）** → 固定方式は下記の「pin 方式」を正とする。
- **pin 方式（§27 と整合）**: `DSH_VERSION = '0.1.0-rc.7'` を package.json の devDependency で宣言し、
  **package-lock.json（lockfile + integrity）で解決を固定**する。実行時は `node_modules/.bin/dsh`
  （lockfile 解決済み）を優先し、レジストリからの無審査実行（npx）はフォールバックに限定。
  さらに §27 の `DSH_COMMIT=<verified-sha>` に従い、H2-B の ACP integration test 検証時に
  検証済み commit SHA を `harness/deepseek.ts` の `DSH_COMMIT` へ記録する。
- 統合方式: dsh を **外部プロセスとして起動**し、アダプタ経由のみで接続
  （ArcAsha の boot に影響ゼロ = Rollback Safety）。ACP（Agent Client Protocol）を H2-B で使用。
- dsh の参考技術（写像パターン）:
  - Waterfall イベント（`agent/pre-step` / `tools/pre-execute` 等）→ HarnessEvent の H2 拡張
  - Event-sourced Session Log（"Model-visible means logged"）→ ArcAsha の replay / trace 設計
  - Capability Seam（Definition / Provider / Consumer）→ H4 Canonical Capability
- 失敗意味論: dsh 起動不能 = **infrastructure throw** / タスク失敗 = **failed** / 不可時は Native フォールバック

## H2-B 実装メモ（ACP 実実行）

- **ACP クライアント**: `harness/acp.ts` — `@agentclientprotocol/sdk`（v1.3.0, Apache-2.0）の
  `ClientSideConnection` + `ndJsonStream` を dsh の ACP サーバー子プロセスの stdio に接続。
  ワイヤーは ACP v1（JSON-RPC over stdio / NDJSON）。`PROTOCOL_VERSION = 1`。
- **実行フロー**: `initialize` → `session/new({cwd})` → `session/prompt({sessionId, prompt})` →
  `session/cancel`（abort 時）。`agent_message_chunk`（テキスト）を `message` イベントへ写像。
- **stopReason 写像**: `end_turn` / `max_tokens` / `max_turn_requests` → `completed` /
  `refusal` → `failed`（code=REFUSAL, retryable=false）/ `cancelled` → `cancelled` イベント。
- **AbortSignal**: adapter が `session/cancel` 通知へ変換。起動中（initialize/newSession 前）の
  abort はプロンプト未開始なので `cancelled` を直接返す。協力的でない子プロセスには
  猶予 5s 後に強制終了（generator が detach されてもプロセスを leak させない）。
- **権限要求**: `session/request_permission` はポリシーで自動応答。`reject`（既定, fail closed）
  は `cancelled`、`allow` は最初の allow オプションを選択。
- **検証**: `selftest [10]` — 実 ACP ワイヤープロトコルを話す mock サーバー
  （`harness/mock-acp-server.mjs`）を子プロセスとして起動し、API キー不要で検証。
  正常ターン / message 写像 / refusal→failed / RPC エラー→infra / クラッシュ→infra /
  abort→cancelled / 権限 reject→cancelled / 権限 allow→completed。
- **実 dsh との接続**: 実行時は `node_modules/.bin/dsh-acp-demo`（lockfile 固定）を起動する。
  現在は未インストールのため `available()=false` → Native フォールバック。
  実サーバーでの integration test 完了時に §27 の `DSH_COMMIT` を確定する。

---

# 32. H0 Acceptance Criteria（実装済み・selftest で検証）

1. Harness を呼び出せる ✅
2. `AsyncIterable<HarnessEvent>` を逐次観測できる ✅
3. `started → completed` が成立する ✅
4. `failed` と iterator throw を区別できる ✅
5. AbortSignal が Harness に伝播する ✅
6. grace period 超過時に execution を detach できる ✅
7. Native Harness を外しても ArcAsha 本体が boot / import 可能 ✅
8. Harness を使用しない既存 Attachment が壊れない ✅

---

# 33-35. H1〜H3 Acceptance Criteria

- H1: 既存 Coding 主要ケースが NativeHarness 経由で成功 / failure が `failed` / `started → completed` / AbortSignal 停止 / NativeHarness を disable しても他 Attachment は動く / Legacy と意味論一致
- H2: 固定 DSH commit で起動 / completed / failed / throw / AbortSignal / grace 内停止 / detach / Native 切戻し（H2-A）+ ACP 実実行: message 写像 / stopReason 写像 / abort→cancelled / 権限ポリシー / infra 分離（H2-B・selftest [10] で検証済み）
- H3: `code.execute` 経路 / progress 観測 / 中途失敗 `failed` / infra `throw` / 同一 taskId 複数 executionId / DSH 無効化で Native 戻し

---

# 36. Rollback Safety

Harness 導入で ArcAsha 本体の boot を壊してはならない。

```text
DeepSeek unavailable → fallback to Native → ArcAsha continues
DSH adapter broken → disable Coding Harness → other Attachments continue
```

---

# 37. Failure Domain

```text
A. Task Failure      → failed event
B. Tool Failure      → failed event / tool_result
C. Harness Failure   → iterator throw
D. Forced Cancellation → detach / cleanup
```

この分類は将来の Router / ODAR の観測意味論になる。

---

# 38. Observability

H0: `taskId / executionId / event.type / timestamp`。H2以降: `tool / latency / retry count / termination reason`。H0〜H3では永続 Session Log 統合を必須にしない。

---

# 39. Security / Isolation

- Harness ABI から直接 `exec()` を提供しない。
- Tool execution policy は Harness 側に隔離する。
- DSH sandbox を利用する場合、ArcAsha から勝手に無効化しない。
- event payload に秘密情報を不用意に流さない。
- tool input/output は将来 redaction / summary 可能にする。

H0では sandbox 実装を作らない。

---

# 40. Data Ownership

| データ | 所有者 |
|---|---|
| logical task | ArcAsha caller |
| executionId | Harness |
| HarnessEvent | Harness |
| HarnessResult | Harness |
| AttachmentResult | Attachment |
| quality / tokens / estimated cost | ArcAsha Attachment/Runtime |
| model/tool specifics | Harness adapter |
| future reward | Router / ODAR |

---

# 41. H4〜H8

- **H4 — Canonical Capability Model**: Router / AILSM / Cognitive Graph の capability を意味論整理
- **H5 — Capability Resolver**: `Task → required capabilities → available Harness/Expert/Tool → candidate plan`
- **H6 — Harness Router**: `Task → Native/DSH/Remote → cost/latency/reliability/capability → selection`
- **H7 — Reasoning Search**: Harness configuration 自体の探索（Hypothesis A=Native / B=DSH / C=Remote）
- **H8 — ODAR Integration**: task/execution success・cost・latency・cancellation reliability・recovery rate・tool/verification success の観測

---

# 42. 将来アーキテクチャ

```text
Master Executive → Coding Attachment → code.execute → Canonical Capability
  → Capability Resolver → Harness Router
  → NativeHarness / DSH Adapter / RemoteHarness
  → Harness Events → Execution / Result → Reasoning / Verification → ODAR / Memory
```

H0〜H3ではこのうち最初の実行経路だけを実装する。

---

# 43. テスト戦略

H0: harness / cancellation / failure-semantics（本 selftest に統合）
H1: native / coding-regression
H2: adapter / cancellation / e2e

必須シナリオ: success / task failure / infrastructure throw / immediate abort / delayed abort / abort timeout / repeated execution / same task different executionId / Native fallback / DSH unavailable

---

# 44. 実装順序

```text
H0.1 types → H0.2 event ABI → H0.3 executionId → H0.4 AbortSignal
  → H0.5 failure/throw semantics → H0.6 executeOnce → H0.7 tests  ← 本実装
H1.1 NativeHarness → H1.2 Coding Attachment bridge → H1.3 regression
H2.1 DSH commit pin → H2.2 DSH adapter → H2.3 event translation
  → H2.4 cancellation → H2.5 cleanup/detach → H2.6 integration
H3.1 code.execute → H3.2 Coding E2E → H3.3 fallback test
```

---

# 45. 成功条件

> **ArcAsha Coding Attachment が、特定の Agent Runtime に依存せず、Event-based Harness ABI を通して実行基盤を交換できるようになった。**

さらに、Native Harness と DeepSeek Harness Adapter の双方で同一 Coding Task を実行でき、途中イベント、失敗、キャンセル、実行試行単位を観測できる。ここまでで H0〜H3 を達成したとみなす。

---

# 46. 参照一次資料

- Attachment ABI / Manager / Coding Attachment / AILSM / Router: `akasha-master/src/arcasha/`
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness （docs/architecture.md）

---

# 47. 最終決定

## 固定する

- Harness は streaming-first
- `taskId` と `executionId` を分離
- `executionId` は Harness が発行
- `AbortSignal` を ABI に含める
- `failed` と iterator throw を分離
- throw 後の final result は無効
- side effect の rollback は保証しない
- H0〜H3 は Capability Resolver / Router / ODAR を変更しない
- DSH は adapter 経由だけで利用
- DSH は特定 SHA に pin
- Native Harness を維持
- DSH を外しても ArcAsha は動作可能

## 後で決める

- Canonical Capability の完全型
- Event 永続化
- DSH Session と ArcAsha Session の統合
- Harness Router の学習アルゴリズム
- ODAR reward
- Reasoning Search の Harness search space
- vendor 化の最終判断
- Edge Client への Harness 展開

---

## 付録A: 最小 ABI（H0 実装済み）

```ts
export interface HarnessTask {
  taskId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessExecuteOptions {
  signal?: AbortSignal;
  cancelGracePeriodMs?: number;
}

export interface Harness {
  execute(task: HarnessTask, options?: HarnessExecuteOptions): AsyncIterable<HarnessEvent>;
}

export type HarnessEvent =
  | { type: "started"; taskId: string; executionId: string; timestamp: number }
  | { type: "completed"; taskId: string; executionId: string; result: HarnessResult; timestamp: number }
  | { type: "failed"; taskId: string; executionId: string; error: HarnessExecutionError; timestamp: number };

export interface HarnessResult {
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessExecutionError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

この ABI は H0 の実装開始に十分な最小仕様であり、H4以降の機能を先取りしない。
