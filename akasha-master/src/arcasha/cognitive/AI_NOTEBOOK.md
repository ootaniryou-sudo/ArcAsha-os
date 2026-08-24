# AI Notebook — Caravan の Single Source of Truth for Task State

> 「キャラバンが一つのノートにメモをまとめながらタスクを完成させる」ための共有作業状態。
> これは単なる共有メモリ（会話ログ）ではなく、**Caravan の作業状態そのもの**である。

- 実装: `akasha-master/src/arcasha/cognitive/`
  - `notebook.ts`（CaravanNotebook: セクション / immutable snapshot / Expert I/O 契約）
  - `caravan-verifier.ts`（成果物検証 + AILSA validator 接続 / `verifyArtifactOnly`）
  - `caravan-loop.ts`（PLAN → EXECUTE → OBSERVE → VERIFY → REPLAN 閉ループ + Budget）
  - `recovery-harness.ts`（Recovery Harness: Notebook=状態とする検証駆動エラー回復閉ループ）
  - `memory-harness.ts`（Memory Harness: Oasis 長期記憶 → 検索・注入・実行・記録の閉ループ）
  - `expert-formation.ts`（Expert Formation: 不足能力推定 → Pool から Expert を動的編成）
  - `oasis.ts`（Knowledge Oasis 拡張: 完成 Notebook snapshot 保存）
  - `demo.ts --caravan`（CLI）
  - selftest: AILSM selftest `[81]〜[87]`

---

## 1. 設計契約

1. **Notebook は「共有ログ」ではなく Caravan の作業状態そのもの。**
   Expert 間の会話履歴は保持しない。「会話の結果として確定した状態」だけを構造化して持つ。
2. **全ての状態遷移（EXECUTE / OBSERVE / VERIFY / REPLAN）は必ず Notebook を経由する。**
   Notebook 外にタスク状態を持つ新規実装を作らない。
3. **`snapshot()` による immutable なバージョン積み上げ（v0 → v1 → v2 …）を第一級機能とする。**
   「なぜこの結論に到達したか」を後から再生可能にする（Decision Explanation / Replay との接続点）。
4. **Expert は `readSections` / `writeSections` の契約で「必要な部分だけ」を読み書きする**
   （Need-to-know。小さいモデルでも現実的なコンテキスト量になる）。
5. **全エントリは型付き IR 値として保存する。**
   自然言語の代替ではなく、「Caravan の共同作業状態を操作する言語」としての IR。

## 2. セクション構造（TASK 〜 FINAL_DIAGNOSIS）

| セクション | 内容 |
|---|---|
| `task` | タスク文・objective（Notebook の起点 v0） |
| `context` | known_facts / constraints / resources |
| `hypotheses` | 仮説 |
| `plan` | 計画（IR: `plan: [...]`） |
| `analysis` | 解析・成果物（IR: `program: [...]` / `solution: x=...` など） |
| `evidence` | 根拠 |
| `decisions` | 確定した決定 |
| `open-questions` | 他 Expert への批判・懸念（確定した懸念だけ） |
| `errors` | 検証失敗などのエラー（REPLAN の入力） |
| `final-diagnosis` | 最終診断（result / confidence / limitations） |

## 3. Caravan Loop（PLAN → EXECUTE → OBSERVE → VERIFY → REPLAN）

```text
1. PLAN     : planning が Notebook に plan（IR）を書く
2. EXECUTE  : 各 Expert が readSections を読み、成果物（IR）を writeSections に書く
3. OBSERVE  : Notebook の現在状態が観測そのもの（共有メモリ不要）
4. VERIFY   : 成果物を検証（回答の良さではなく成果物の検査）
5. PASS     : FINAL_DIAGNOSIS を書いて終了（verified）
   FAIL     : ERRORS を書いて REPLAN（次の Round で再計画・再実行）
```

### Budget（予算）

| 項目 | 既定 | 超過時 |
|---|---|---|
| `maxRounds` | 3 | `stopReason = 'max-rounds'` |
| `thinkingBudgetMs` | 5000 | `stopReason = 'budget-exhausted'` |
| `expertBudgetMs` | 2000 | `stopReason = 'budget-exhausted'` |

実行後は `remainingBudgetMs` で残予算が観測できる。

## 4. Verifier（成果物検証・Phase B）

「回答の良さ」の評価ではなく**成果物そのものの検査**を実装する（100% 決定論）。

- coding: `program` アーティファクトの構造検証（build / test 相当）
- math: `solution` アーティファクトの構造検証（数値検証相当）
- AILSA 接続: `Instruction[]` は `ailsa/validator.validateProgram` で検証（`verifyAilsaProgram`）

## 5. Recovery Harness（Notebook=状態 / 検証駆動エラー回復閉ループ・PR 1）

> 同一タスクに対し、**Verifier による失敗検出 → 回復戦略選択 → 再実行**で完了可能な
> 閉ループを構成できることを証明する。性能改善は主張しない（Ablation は PR 3）。

- **Notebook が状態、RecoveryHarness は状態遷移を実行する機械。**
  RecoveryHarness は独自の Task State / Notebook 改竄を行わない。
  全ての観測（ERRORS）と決定（DECISIONS）は Notebook に追記される。
- **Recovery Strategy は型として固定**: `Retry / Replan / AddExpert / Abort`。
- **Strategy 選択の根拠（reason）を必ず Notebook.DECISIONS に残す**（Decision Explanation /
  Policy Learning への接続点）。`addedCapability` で不足能力を明示（AddExpert 時）。
- **既存 Harness ABI を実装する decorator**（`Harness`）。base executor には
  Native / DSH / 実モデル / 決定論 Simulation（`createAttemptArtifactHarness`）を渡せる。

### 閉ループ

```text
EXECUTE（buildAttemptTask で Notebook 状態を注入）→ ANALYSIS に成果物追記
  → VERIFY（verifyArtifactOnly: plan 不要のアーティファクト検証）
    → PASS: FINAL_DIAGNOSIS + completed
    → FAIL: ERRORS 追記 → selectStrategy → DECISIONS 追記 → recover（再 EXECUTE）
```

### 既定の回復戦略ポリシー（決定論）


| 検証結果 | 戦略 | 根拠（DECISIONS に残る） |
|---|---|---|
| Plan 検証失敗 | `Replan` | plan が検証を満たさない |
| 実行基盤の失敗 / 形式不良 / IR 制約外 | `Retry` | 一時障害・形式不良は再実行で回復 |
| アーティファクト欠落 | `AddExpert` | 不足能力を追加（addedCapability） |
| 未分類 | `Retry` | フォールバック |

> `Abort` は `defaultRecoveryPolicy` は返さない。`maxAttempts` 上限到達
> （RECOVERY_EXHAUSTED）時にループ側が `failed` を発行する。`Abort` 決定・上限到達時は
> `retryable: false` になる（回復不能の明示）。

### パラメータ

| 項目 | 既定 | 意味 |
|---|---|---|
| `maxAttempts` | 3 | 最大試行回数（超過 = RECOVERY_EXHAUSTED） |
| `roundBudgetMs` | 5000 | 1 回の EXECUTE の予算（超過 = round-timeout → 回復） |
| `verify` | `verifyArtifactOnly` | アーティファクト検証（差し替え可） |
| `selectStrategy` | `defaultRecoveryPolicy` | 回復戦略選択（差し替え可） |

失敗履歴（failure history）は Notebook.ERRORS に集約され、
snapshot（v0→vN）が決定論的に積み上がる（Decision Replay）。

## 6. Memory Harness（Oasis 長期記憶 → 検索・注入・実行・記録・PR 2）

> Knowledge Oasis を長期記憶とする「記憶の検索 → 注入 → 実行 → 記録」の閉ループを
> 構成できることを証明する。性能改善は主張しない（Ablation は PR 3）。

- **Notebook が実行時状態、KnowledgeOasis が長期記憶。** MemoryHarness は状態遷移を
  実行する機械で、Oasis を直接書き換えず、記録は明示的な `recordBack` 経由。
- **閉ループ**:
  `RETRIEVE（oasis.recommend）→ INJECT（タスク文へ合成 + Notebook.context に memory IR）→ EXECUTE → RECORD（Oasis へ成功/失敗を記録）`
- **既存 Harness ABI を実装する decorator**（`Harness`）。RecoveryHarness と合成できる
  （Memory が文脈供給、Recovery が検証・回復）。
- **メモリ IR は Notebook.context に記録**（`memory: [retrieved=N, sources=[...] lessons=[...]]`）。
  基盤 Harness は `task.metadata.memory`（`parseInjectedMemory`）で参照できる。

### パラメータ

| 項目 | 既定 | 意味 |
|---|---|---|
| `maxMemory` | 3 | 検索で取得する経験の上限 |
| `retriever` | `defaultMemoryRetriever`（recommend） | 検索関数（差し替え可） |
| `recordBack` | true | 実行結果を Oasis へ記録するか（false = 読み取り専用） |
| `notebook` | なし | あれば `context.memory` を追記し `recordCaravan` で記録 |

## 7. Oasis 保存 + Decision Replay

`runCaravan` 完了時、Knowledge Oasis に以下を保存する（次回推薦材料 / Decision Replay）。

- 完成 Notebook の immutable snapshot（`notebookSnapshot`）
- 成功 / 失敗の Team・Plan
- 最終診断（`diagnosis`）

`notebook.history()` が v0 → vN の全スナップショットを返し、「なぜこの結論に到達したか」を再生できる。

## 8. Expert Formation（Dynamic Expert Formation・PR 3）

> 「浮動している専門 AI の凸凹を Caravan が組み合わせ、一時的なタスク専用 AI を作る」構想の実装。
> 検証失敗から不足能力を推定し、Pool から Expert を選んで Caravan を動的に変形できることを証明する。

```text
Failure
  ↓
Notebook（ERRORS / DECISIONS / 検証結果）
  ↓
不足能力を推定（inferMissingCapability）
  ↓
Pool / Capability Graph（候補 Expert）
  ↓
候補ランキング（cost / latency / capability）
  ↓
Expert 選択（defaultFormationPolicy）
  ↓
Caravan へ attach（formationExpertFromPool: Notebook を必要部分だけ共有）
  ↓
再実行（runCaravan の次の Round）
```

- `runCaravan` に `formation` / `pool` / `maxFormation` オプションを追加。VERIFY 失敗時に編成し、
  拡張したチームで次の Round を実行する。
- 編成決定は **Notebook.DECISIONS** に `decision: [action=AddExpert, expert=..., reason="..."]` として
  記録（**RecoveryHarness の AddExpert 戦略と同じ IR 形式**。両者は DECISIONS で接続される）。
  - 正規化後の AddExpert IR: `decision: [action=AddExpert, expert=<id>, reason="<理由>", addedCapability=<role>]`
    （`reason` の構造文字 `\ " [ ]` はエスケープ済み。`inferMissingCapability` は `addedCapability=` /
    `expert=` の両方を再生できる）。
- `inferMissingCapability` は検証結果 / ERRORS / **DECISIONS の addedCapability** / ドメイン /
  `detectRoles`（capability-graph）から不足能力を推定する。
- PoolExpert に execute が無い場合は決定論 Simulation で IR を生成（`formationExpertFromPool`）。
- `ExpertFormationPolicy` は差し替え可（ルールベース → 学習 → Oasis ベースへ発展できる）。

## 9. 実装ガード

- Notebook 外にタスク状態を持つ新規実装を作らない（RecoveryHarness / MemoryHarness / Expert Formation も例外ではない）
- 既存機能を壊さない（ailsm / ailsa / harness / golden の回帰を維持）
- selftest `[81]〜[87]` で検証
- `npm run build` / `npm run ailsm:selftest` / `npm run ailsa:selftest` / `npm run golden` / dist まで確認

---

## 実行

```bash
# Caravan Loop デモ
cd akasha-master
npx tsx src/arcasha/cognitive/demo.ts --caravan

# セルフテスト（[81]〜[87] を含む）
npm run ailsm:selftest
```
