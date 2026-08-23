# AI Notebook — Caravan の Single Source of Truth for Task State

> 「キャラバンが一つのノートにメモをまとめながらタスクを完成させる」ための共有作業状態。
> これは単なる共有メモリ（会話ログ）ではなく、**Caravan の作業状態そのもの**である。

- 実装: `akasha-master/src/arcasha/cognitive/`
  - `notebook.ts`（CaravanNotebook: セクション / immutable snapshot / Expert I/O 契約）
  - `caravan-verifier.ts`（成果物検証 + AILSA validator 接続）
  - `caravan-loop.ts`（PLAN → EXECUTE → OBSERVE → VERIFY → REPLAN 閉ループ + Budget）
  - `oasis.ts`（Knowledge Oasis 拡張: 完成 Notebook snapshot 保存）
  - `demo.ts --caravan`（CLI）
  - selftest: AILSM selftest `[81]〜[84]`

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

## 5. Oasis 保存 + Decision Replay

`runCaravan` 完了時、Knowledge Oasis に以下を保存する（次回推薦材料 / Decision Replay）。

- 完成 Notebook の immutable snapshot（`notebookSnapshot`）
- 成功 / 失敗の Team・Plan
- 最終診断（`diagnosis`）

`notebook.history()` が v0 → vN の全スナップショットを返し、「なぜこの結論に到達したか」を再生できる。

## 6. Phase C 接続口（Dynamic Expert Formation）

- `runCaravan` は `team: NotebookExpert[]` を受け取る。Phase C ではここを
  `composeTeam` / Oasis 推奨で動的に編成する。
- 本実装（Phase A+B）は**固定 Caravan + 固定 Expert**（`fixedCaravan`）で行う。
- `notebookExpertFromPool`（notebook.ts）が PoolExpert → NotebookExpert の変換口を提供する。

## 7. 実装ガード

- Notebook 外にタスク状態を持つ新規実装を作らない
- 既存機能を壊さない（ailsm / ailsa / harness / golden の回帰を維持）
- selftest `[81]〜[84]` で検証
- `npm run build` / `npm run ailsm:selftest` / `npm run ailsa:selftest` / `npm run golden` / dist まで確認

---

## 実行

```bash
# Caravan Loop デモ
cd akasha-master
npx tsx src/arcasha/cognitive/demo.ts --caravan

# セルフテスト（[81]〜[84] を含む）
npm run ailsm:selftest
```
