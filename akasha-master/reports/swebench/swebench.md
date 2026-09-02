# SWE-bench 実問題検証（2026-09）

SWE-bench Lite（`princeton-nlp/SWE-bench_Lite`）の実インスタンスを、ArcAsha の
ソフトウェアエンジニアリングエージェント（`src/arcasha/swe/`）で解決した結果。
数値はすべて実 API（`deepseek-v4-flash`・`temperature=0`）での実測です。

## 結果（3/3 = 100%）

| instance_id | 問題 | resolved | model calls | tool calls | 所要時間 | パッチ |
|---|---|---|---|---|---|---|
| `sympy__sympy-24213` | `_collect_factor_and_dimension()` の次元等価性判定 | ✅ | 26 | 31 | 93s | 717 B |
| `sympy__sympy-23117` | `sympy.Array([])` 空配列バグ | ✅ | 29 | 44 | 206s | 1,813 B |
| `sympy__sympy-24152` | `TensorProduct.expand()` 不完全展開 | ✅ | 11 | 13 | 71s | 930 B |

- F2P 全テスト・P2P 回帰テストがすべて pass
- エージェントはソースのみを修正し、`run_command` で pytest を実行して検証

## 正直な注記

- LLM は確率的なため実行ごとに結果は変動（`23117` は 1 回「不完全応答」で未解決 → 再実行で解決）
- `22005` は base_commit（2021）が Python 3.13 の `distutils` 削除と非互換のため評価対象外
- サンプル 3 問・選定バイアスがあり、統計的な解決率の推定ではない
- この実行ではトークン集計（usage）導入前のためトークン消費量は未記録。
  ハーネス（`agent.ts`/`eval.ts`）に集計を追加済み。次回以降は本ファイルの
  `swebench-results.json` に `agentPromptTokens`/`agentCompletionTokens`/
  `agentTotalTokens` として記録される

## 実験条件（抜粋）

- 対象: SWE-bench Lite test split から sympy/sympy の 3 問を選定（依存ゼロの純 Python）
- モデル: `deepseek-v4-flash`（実 API・`temperature=0`）
- 環境: macOS / Python 3.13.2 / pytest 9.1.1 / sympy（base_commit）を editable install
- エージェント: ツールループ maxIterations=50（list_dir / read_file / grep_search /
  glob_search / write_file / edit_file / run_command）
- 評価: base_commit checkout → エージェントがソースのみ修正 → 巻き戻し → gold
  `test_patch` 適用 → エージェントパッチ適用 → F2P/P2P を pytest → F2P 全 pass で resolved

## ファイル

| ファイル | 説明 |
|---|---|
| `swebench-results.json` | 評価結果（model patch・F2P/P2P テスト結果・calls/ms） |
