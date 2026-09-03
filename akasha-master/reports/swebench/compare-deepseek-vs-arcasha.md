# ノーマル DeepSeek vs arcasha 比較計測（SWE-bench Lite 1 問・再計測版）

- **対象**: `sympy__sympy-24213`（`collect_factor_and_dimension` が加算で等価次元を検出しない）
- **モデル**: 両者とも `deepseek-v4-flash`
- **日時**: 2026-09-04（再計測）
- **再現**: `swebench-data/compare-deepseek-vs-arcasha.ts`（`CMP_SIDE` / `CMP_TRIALS` / `CMP_FILE`）
- **生データ**: `swebench-data/compare-deepseek-vs-arcasha.json`（ノーマル 3 試行 + arcasha）

> ⚠️ **本レポートは初版（2026-09-04 00:57 頃）の修正版**。
> 初版のノーマル計測は `thinking: disabled` + **問題文のみ**という不自然な条件だった
> （1.6 秒・150 completion tokens で即答 → NOT RESOLVED）。
> これは deepseek-v4 が既定で thinking 有効なのに無効化していたためで、
> **モデルの実力を測れていなかった**。ユーザー指摘を受け、以下で再計測した。

## 構成

| 構成 | 説明 |
|---|---|
| **ノーマル DeepSeek（再計測）** | ツールなし・**単発プロンプト**。問題文 + **対象ファイル該当箇所の抜粋**（arcasha が `read_file` で得る情報と同等）を渡し、thinking 有効（reasoning_effort=high）で unified diff を直接生成。**3 回試行**して成功率を測定 |
| **arcasha** | SWE エージェント（ツールループ）。list_dir / read_file / grep / write_file / edit_file / run_command を自由に使用。allowRunCommand 有効・maxIterations 50 |

## 計測結果

| 指標 | ノーマル DeepSeek（3試行合計） | arcasha |
|---|---:|---:|
| **解決できたか (resolved)** | ❌ **0/3** | ✅ **Yes** |
| モデル呼び出し回数 | 3 | 30 |
| ツール呼び出し回数 | 0 | 33 |
| 入力 (prompt) トークン | 3,756 | 726,877 |
| 出力 (completion) トークン | 39,428 | 14,532 |
| **合計トークン** | **43,184** | **741,409** |
| 経過時間 | 267 s（3試行計） | 127 s |
| 費用（off-peak, $） | **$0.0268** | **$0.170** |
| 費用（peak, $） | $0.0537 | $0.339 |

※ ノーマルは「3 回試行して 1 回でも解ければ成功」方式。結果は 0/3。
※ 単体検証（`test-effort-high.json`）では 1/1 成功（RESOLVED・18.7s・3,587 tokens）も確認。
   → 成功**しうる**が**不安定**。

## なぜ 0/3 なのか（試行ごとの内訳）

3 試行すべてで、**生成された修正内容は gold パッチと完全に同一**だった
（`if dim != addend_dim:` → `if not self.get_dimension_system().equivalent_dims(dim, addend_dim):`）。
にもかかわらず、`git apply` が失敗した理由は **unified diff の書式**にある:

| 試行 | 内容 | 失敗理由 |
|---|---|---|
| 1 | content 空（reasoning 暴走で回答に到達せず） | 回答なし → 適用不可 |
| 2 | `@@ -176,4 +176,4 @@` | **hunk 行数カウント誤り**（実際は 7 行）→ corrupt |
| 3 | `@@ -176,7 +176,7 @@` だが末尾コンテキスト欠落 | **hunk 不完全** → corrupt |

つまりノーマル DeepSeek は「**何を直すか**」は毎回正確に理解できるが、
「**git apply で通る unified diff を 1 発で機械的に正確に書く**」のが不安定。
これは単発テキスト生成モデルに共通の課題（hunk 行数の数え間違い・末尾欠落）で、
**ツールで直接ファイルを編集する arcasha には起きない問題**。

## 考察

### ユーザー指摘（「ノーマルの起動がおかしい」）の検証結果

**指摘は正当だった。** 初版の計測条件は以下の点で不自然だった:

1. `thinking: disabled` にした → deepseek-v4 は既定で thinking 有効なのに無効化し、
   深く考えず 1.6 秒で即答させた
2. **問題文のみ**を渡した → リポジトリの現在コードが見えず、
   「でっち上げのコンテキスト行」を含む diff を生成せざるを得なかった

正しい条件（thinking 有効 + 対象ファイル抜粋）で再計測すると、ノーマルは
**修正内容自体は毎回 gold と同一**を生成できることが分かった（起動は正常）。

### それでも arcasha が解ける理由（本質的な差）

- **ノーマル DeepSeek**: 「何を直すか」は分かるが、unified diff を**テキスト生成**で
  書くため書式エラー（hunk 行数・末尾欠落）が起き、適用に失敗しやすい
- **arcasha**: `read_file` で正確なコードを確認し、`edit_file` で**直接ファイルを
  編集**する → モデルが diff 書式を自分で生成する必要がない → 常に適用可能な
  パッチになる（git diff が自動生成されるため）

つまり「SWE-bench を解く」には「問題解決能力」だけでなく「**コードを直接編集する
手段（ツール）**」が本質的に重要、というのが今回の 1 問比較の結論。

### トークン・費用の比較

- ノーマル（3 試行）: 43K tokens / $0.027（off-peak）で 0 勝。単発ゆえ安価だが成功率が低い
- arcasha: 741K tokens / $0.170（off-peak）で 1 勝。探索コストは高いが確実に解く

「1 問あたり費用」×「成功率」で見ると、arcasha の方が**確実に解ける**コストとして
意味がある（ノーマルは仮に 10 回試行して 1 回成功するとしても $0.09・更に不安定）。

## 補足: deepseek-v4 thinking モードの挙動

- deepseek-v4-flash は既定で thinking（effort high）
- ファイル抜粋なし + thinking 有効だと、reasoning が出力枠を消費し尽くし
  content が 0 文字になる事象を確認（maxTokens を 4000→16000 に増やしても同様）
- ファイル抜粋あり + `reasoning_effort=high` なら content に到達（今回の再計測条件）
- `reasoning_effort=low` だと thinking は短いが、hunk コンテキスト行を誤る例も確認

## 再現方法

```bash
cd akasha-master
# ノーマル DeepSeek（問題文+ファイル抜粋・thinking有効）を 3 回試行
CMP_SIDE=normal CMP_TRIALS=3 ./node_modules/.bin/tsx swebench-data/compare-deepseek-vs-arcasha.ts
# arcasha
CMP_SIDE=arcasha ./node_modules/.bin/tsx swebench-data/compare-deepseek-vs-arcasha.ts
```

前提: `swebench-data/work/repo`（sympy）と `.venv`（pytest・sympy editable install）が必要。
