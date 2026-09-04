# INNOVATIONS — ArcAsha の革新技術まとめ

> 本プロジェクト（ArcAsha / Akasha-OS）は **「より大きなモデル」ではなく「AI 知能を OS レベルで構成・制御・計測できる実験基盤」** を目指す。
> ここでは、モデル（Transformer）の事前学習とは **直交する軸** にある革新技術を、実装・仕様・実証データとともに整理する。

リポジトリは 2 つの独立プロジェクトから成る。

| プロジェクト | 役割 | 主な革新 |
|---|---|---|
| **ArcAsha-Core / MetaOS**（`akasha-master/`） | モデル非依存の AI オーケストレーション OS | AILSA/AILSM・AVM・Executive・Attachment・Cognitive Graph など |
| **Akasha-Link**（`akasha-link/`） | 分散推論・テンソル伝送エンジン（WebGPU） | Akasha Wire Protocol・ゼロコピーバイナリ中継・フォールトトレランス |

---

## 1. AI OS パラダイム —「モデルの外に OS を置く」

- **革新**: GPT / MoE が推論をニューラル内部のブラックボックスで行うのに対し、ArcAsha は **モデルを変更せずモデルの上に OS 層** を置き、推論・記憶・思考・学習を OS 資源として管理する。
  - 推論 = **スケジューリング可能な資源**（CPU のプロセス）
  - コンテキスト = **仮想メモリ**（RAM のデマンドページング）
  - 高度な知能 = **オプションのカーネルモジュール**（Linux の insmod/rmmod）
- **対応表（Linux 比較）**: Caravan=Process / Dynamic Cognitive Graph=Thread / Knowledge Oasis=Memory / Executive=Scheduler / AILSM IR=System Call(ABI) / Kernel+AVM=Kernel
- **仕様**: `MASTER_SPEC.md`, `ARCHITECTURE.md`, `ARCASHA_V2_SPEC.md`

## 2. AILSA / AILSM —「推論の機械語」と「AI の内部状態 IR」

### AILSA（AI Instruction Set Architecture）

- レジストリ **v1.3.0（85 命令）**。バイナリ形式は `Opcode + Slot + varint + UTF-8`。決定論的で検証可能な AI カーネル向け ISA。
- **v1.3.0 拡張（SWE 対応）**: code 方言に `GREP 0x56` / `READ_FILE 0x57` / `EDIT_FILE 0x58` / `RUN_COMMAND 0x59` を追加。自然言語「…を読んで / コードを検索して / …を修正して / テストを実行して」が SWE 命令列へコンパイルされる（golden 38 ケースで回帰保証）。ファイルパス（`src/…/tools.ts`）が数式と誤判定されない lexer ルールも導入。
- **v1.3.0 拡張（分散・教訓・観測・検証）**: base 拡張制御として `NODE_SEND` / `NODE_RECV` / `BARRIER` / `REDUCE`（分散）、`LESSON_STORE` / `LESSON_RETRIEVE`（教訓）、`TRACE_POINT`（観測）、`ASSERT`（実行時検証）を登録。これにより SWE / 分散推論 / 教訓 / Observability が 1 つの IR で記述・制御・計測できる。
- **仕様**: `AILSA_ISA.md`, `AILSA_RUNTIME.md`

### AILSM（AI 向けセマンティック中間表現, SSA グラフ IR, v1.8）

- **Task / Object / Value / Memory / Belief / Plan / Reflection / Capability / Schedule / Process / Thread / Namespace / Context / Page / Slice / Cache / Execution / Chunk / Span / Frame / Hypothesis / Executive / MetaExecutive / Expert** がすべて first-class ノード。
- エッジ: `uses / produces / stores / informs / plans / reflects / contains / hypothesizes / expands / manages / specializes / mergesInto`。
- **型付き IR**（union / optional / `NodeConstraints` による静的検査）で実行前の矛盾排除・正準化（同一意味 = 同一ノード）が可能。
- **AI Operating IR**: 意味表現だけでなく「AI の思考・状態・学習・記憶・計画・信念」を SSA として保持する実行可能 IR。
- **重要定義**: 「IR は知識の言語ではなく、推論の制御と実行フローの言語」。知識量と無関係に IR は小さいまま保てる。
- **仕様**: `AILSM_IR.md`, `AILSM_COMPILER.md`, `AI_IR_MODEL.md`

### 制御プレーン / データプレーン 2 層構造

- **制御プレーン** = 閉じた語彙（Opcode。誰に・何を・どう検証するか）
- **データプレーン** = 開いたスロット（コード・数式・テキストなどの成果物）
- モデルは IR を「理解しない」。**OS 側のドライバ（`RemoteDriver`）が IR と自然言語を橋渡し**（USB コントローラの比喩）するため、任意のバックエンド（MLX / OpenAI / Anthropic / WebGPU）を接続できる。

### SWE Agent Toolset（エージェント用ツール群・8 → 20 種）

- モデルは「読む・検索する・編集する・実行する」を **JSON 引数の関数呼び出し**で行う。ツール実装（OS 側）が realpath 境界・テストファイル保護・タイムアウト・出力制限を 100% 決定論で保証する（モデルはファイルシステムの安全を任されない）。
- **ツール拡張（v1.4）**: 編集の精密化（`replace_all` = 全置換 / occurrence=N 番目、`insert_line` / `append_line`）、git 連携（`git_status` / `git_diff` / `git_revert` = ファイル単位のロールバック）、テスト実行（`run_tests` = pytest ラッパー。シェル文字列を組まず引数分離で安全）、検索強化（`grep_context` = grep -C 相当 / `find_symbol` = 言語別の定義行検索）、ファイル操作（`move_file` / `delete_file` / `delete_dir`）。
- **安全設計**: 全パスは root 配下に realpath 解決（symlink 迂回は拒否）、テストファイル（SWE-bench の gold patch が当たる場所）への書き込み・削除・revert は禁止、任意コマンドと `delete_dir` は opt-in。
- **実証**: SWE-bench（sympy 3問）を解く最小構成を維持したまま、Claude Code 級の編集・検証・ロールバックを追加。golden 38 + tools-test 全パス + memory 34 passed で回帰保証。

## 3. AVM — AI Virtual Memory（コンテキストの仮想記憶化）

- 既存 LLM の「コンテキスト窓を 200K/1M トークンへ拡大」に対し、**必要なコンテキストだけをデマンドページングで供給**する「AI 仮想記憶」。
- **5 層**: Context Virtual Memory → Context Paging → Context Scheduler/Slice Loader → **Long Context ABI（`ContextRef` = file descriptor）** → Context Cache
- **Execution Context / Context Switch / Context Fault / Prefetcher**: AI の思考途中（現在ページ・仮説・コールスタック）を保存・復元し途中再開を可能にする（CPU のプロセスコンテキスト / ページフォールトのアナロジー）。
- **メモリ階層**: Document → Page → Chunk（段落）→ Span（文/数式）＝ SSD → Page → Cache Line → Register に対応。Math Expert は数式 Span だけを読む。
- **Context TLB / Hot-Warm-Cold Tier / Reasoning Stack（複数仮説の分岐→merge）** も実装。
- **実証（実 API・Phase 4）**: 12,668 文字 / 396 ページの長文文書で、AVM ON は入力トークン **8,382 → 290（96.5% 削減）**・コスト 94.7% 削減・精度 **100% 維持**（ページ供給 39/396 = 9.8%）。
- **仕様 / 実装**: `AI_VIRTUAL_MEMORY.md`, `src/arcasha/ailsm/{avm,context,slice,cache,execution,demand-paging,chunk,context-tlb,tier}.ts`

## 4. Reasoning Runtime — 推論そのものを OS のスケジューリング対象に

- **Hypothesis SSA**: 仮説を `SPAWN / EVALUATE / ACCEPT / KILL / MERGE` できる first-class ノードにする（生成・競争・淘汰・統合）。
- 各仮説 = **独立 AI プロセス**（OS レベルの並列実行）。MoE が内部で暗黙に行う探索を **OS で明示的に管理** する点が新規性。
- **Reasoning Graph / Tree**: 分岐・循環・統合を表現。
- **探索ポリシーのプラグイン化**: `BeamSearch / BestFirst / DFS / BFS / MCTS(UCB1)`。
- **探索 vs 活用の明示制御**: `selectionScore = score×(1−explore) + novelty×explore − cost×costPenalty`。低スコアでも新規性が高ければ生き残る「仮説の多様性」を MoE より明示的に制御。
- **仕様 / 実装**: `AI_REASONING.md`, `src/arcasha/search/`, `reasoning.ts`, `reasoning-search.ts`

## 5. Executive / Meta Executive / Expert Evolution — 推論を指揮し、学び、進化させる

- **Executive**: ゴール保持 / 優先順位変更 / Expert 編成 / 探索ポリシー・ビーム幅・温度変更を唯一実行できる層。ループ `READY → EXPAND → EVALUATE → REFLECT → EXECUTIVE（戦略切替）→ 次ラウンド`。**探索の途中で戦略を動的に切替**（停滞検知→探索へ、成功+淘汰→活用へ）＝ Transformer 内部では不可能な制御。
- **Meta Executive**: Executive の設定自体をオンライン学習ループ（設定 → 実行 → 評価 → 改善）で最適化。`estimateBudget` による **Thinking Budget**（「そもそも今考えるべきか」の判断。trivial タスクでは推論禁止、バッテリ残量で抑制）も管理。
- **Expert Evolution**: Expert が **split / merge / retire**（専門化・統合・引退）する。Health / Overlap / Utilization 等の客観指標で進化し、ルーティングの固定単位から「生態系」へ。AILSM では `specializes` / `mergesInto` エッジで表現。
- **実証**: Executive 導入で Qwen1.5B の品質 0.50 → 0.71 / Meta Executive は同品質を約 4 割少ない推論回数で達成。Phase 4 実 API では Executive 起因レイテンシを +348ms → **+37ms** に削減（二重モデル呼び出しバグを修正）。
- **仕様 / 実装**: `AI_REASONING.md`, `src/arcasha/{executive,meta-executive,expert-evolution,planner}.ts` ほか

## 6. Intelligence Attachments / Thinking Modes — 知能はオプションのカーネルモジュール

- **Kernel は小さく安定、高度な知能は Attachment（プラグイン）** として必要なときだけ遅延ロード（Linux の insmod / rmmod と同じ思想）。Kernel 状態へは直接触れず、全通信は Executive 経由（`AttachmentContext` のみ）。
- **内蔵 7 種**: Reflection / Debate / Planning / Search / Creativity / Simulation / Coding。既存の Reasoning / Search / AILSM Plan / Hypothesis SSA をパイプラインとして再利用。
- **Thinking Modes**: Fast / Auto / Deep / Custom — 同じ OS の上で実行パイプラインだけを変える（ブラックボックスの「Thinking ON/OFF」ではなく構成が可視化される）。
- **Intelligence Scheduler / Thinking Budget**: `usedMs ≤ budgetMs` を守り、`Reflection 150ms / Debate 400ms / TOTAL 550ms` のように思考の内訳を可視化（他モデルにはない透明性）。
- **実証**: Attachment Ablation（Reflection +76% / Coding +80%）・モード比較（Fast は最速・最安、Auto/Deep は品質向上）・ロボット閉ループ（**Fast 30.3fps** 維持 vs Deep 1.2fps で破綻）。
- **仕様 / 実装**: `AI_ATTACHMENTS.md`, `src/arcasha/attachments/`（`attachment.ts` / `manager.ts` / `scheduler.ts` / `modes.ts` / `builtin.ts` ほか）

## 7. Explainable AI OS — Decision Explanation / Decision Replay / OS Policy Learning

- **Decision Explanation**: 「なぜ Reflection / Planning / Debate を使ったのか」を **期待ゲイン・コスト・理由** で説明（Attention Weight より人間に理解しやすい）。
- **Decision Replay**: 回答に至った全ステップ（モード・Attachment・理由・ゲイン・出力）を Round ごとに動画のように再生（`arcasha replay`）。
- **OS Policy Learning**: Decision Log の実測成果から各 Attachment のゲインを **EMA（α=0.3）** で学習し、Meta Executive のポリシー（説明文の期待ゲイン）へ反映。「意思決定が訓練データになる」**Transformer 事前学習とは直交する学習軸**。
- **実証**: 学習前の期待ゲイン（debate +22% 静的）が、実測後 **+40%** に更新（総合 +34% → +43%）。
- **仕様 / 実装**: `AI_VALIDATION.md`, `src/arcasha/attachments/{explain.ts,decision-log.ts,replay.ts}`

## 8. Composable Intelligence / Cognitive Graph — モデルを選ばず「タスクごとに知能の配線を生成」

- **AI Pool / Capability Graph（凸凹 = データ型）**: 各 Expert が `inputType / outputType` を持ち、型チェーンで自動配線（camera → Vision → object-list → Physics → trajectory → Coding → program）。型が合わない箇所は共有メモリ（Memory Expert）を経由。
- **Caravan（タスクごとの一時チーム）**: タスク完了後に解散してプールへ戻る。フラット構成より **10,000 台で Master の管理対象を 9.99x 削減**（Validation F）。
- **共有タスクメモリ + IR 通信**: 全 Expert が共有メモリを読み書きし AILSM IR で会話。**自然言語は入口と出口だけ**。
- **Knowledge Oasis（長期記憶）**: Task / Reasoning / Team / Policy / Lesson のアーカイブ + **Need-to-know 権限**（Master=全部 / Caravan / Expert=最小限）+ Runtime Knowledge Base（類似タスク検索 → 成功率順のチーム推奨）。
- **Team Learning**: 成功率・品質でチーム編成を学習（`planning>vision>physics>coding` 95% を優先）。**モデルの重みではなく OS レベルの運用知識**（再学習不要）。
- **実証（Validation G）**: 1000 タスクで成功率 **67% → 93%（+26pt）**・遅延 −77ms・品質 +28pt。学習が進むほど改善（warmup 75% → late 93%）。
- **仕様 / 実装**: `AI_COGNITIVE.md`, `ARCHITECTURE.md`, `src/arcasha/cognitive/`（`pool.ts` / `capability-graph.ts` / `runtime.ts` / `team-learning.ts` / `oasis.ts`）, `src/arcasha/hierarchy/`

## 9. 科学的検証基盤 — Simulation と Real Device の分離・再現可能ベンチ

- **Simulation と Real Device を明確に分離**。実機未接続時は `not-connected` を返し **数値を偽造しない**（設計上の評価モデルは `kind: 'simulation'` と明示）。
- **決定論的品質モデル + 外部ベンチ**: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench を Qwen1.5B で評価し **全体 27% → 95%**（+Fast/Auto/Deep の OS 層による引き出し）。「Qwen Thinking vs ArcAsha」の直接比較を含む。
- **実 API アブレーション（Phase 4）**: Baseline / +AVM / +Executive / Full を同一タスク・同一モデルで比較し、McNemar 検定などの統計手法で有意性を確認。`reports/` に JSON/CSV/MD を自動生成して追試可能に。
- **仕様**: `AI_VALIDATION.md`, `AI_EVALUATION.md`, `src/arcasha/bench/`, `src/arcasha/attachments/validation.ts`

## 10. Belief-Driven AI Orchestration — 観測→信念→能力推定の閉ループ

- **シャドウ実行（Shadow / Full-Information Bandit）**: 選択した Expert だけでなく全 Expert を毎ステップ評価し、部分情報をフル情報へ変換。UCB のリグレットギャップ 94% 解消（9.58 → 0.60）などの実験的裏付け（EXP-0000〜0003F）。
- **Belief（ベイズ状態推定）**: Beta-Bernoulli 事後平均 + 信頼度 $g(n)=1-e^{-n/\tau}$ + **有効能力 $\hat\mu=\mu\cdot g$** を 8 次元特徴ベクトルに組み込み、**LinUCB** が重み学習。
- **中心命題（P4）**: capability 推定が支配的メカニズム — capability 特徴量を除くとリグレットが **+37.6%**（p<0.001）。
- **形式的命題**: Proposition 1（シャドウの弱支配）/ 2（リグレット分解）/ 3（累積リグレスト上界 $O(d\sqrt{T}\log T)$）/ 4（閉ループ成立条件）まで数式レベルで統一言語化。
- **適用**: Routing（誰が解くか）/ Planning（どんなプランか）/ Memory（何を思い出すか = 事前信念の初期化）/ Reflection（どう改善するか = 失敗信念からの原因診断）のすべてを Belief で駆動。
- **仕様 / 実装**: `akasha-master/src/arcasha/FRAMEWORK.md`, `experiments/`（EXP-0000〜0003F）, `src/arcasha/core/observation.ts` ほか

## 11. Akasha-Link — 分散推論 / テンソル伝送エンジン（WebGPU エッジ）

- **Akasha Wire Protocol**: データプレーンで **JSON を禁止** し、単一 `ArrayBuffer`（固定 **48 バイトヘッダ + `Float32Array` ペイロード**）で通信。ペイロードを **そのまま WebGPU へアップロード**（ゼロコピー）。MAGIC `0x414B5348`（AKSH）。
- **コマンド**: `REGISTER / HEARTBEAT / COMPUTE_TASK / RESULT / FAILOVER / RELAY / TOKEN_OUT / BENCHMARK / ASSIGN / ACK / DEREGISTER`。クラスタ ID で意味的 Expert クラスタ（math / code / language …）にルーティング。
- **SPSC lock-free リング**: `SharedArrayBuffer` 上の head/tail 方式で Main Thread / Router Worker / Network Worker 間をスレッドセーフに接続。
- **フォールトトレランス**: `Deadline = EWMA(latency) + margin` 超過時に同じバイナリテンソルをシャドウノードへ複製（`SHADOW` フラグ）。**最初の RESULT が勝ち**、敗者は `txId` の冪等性で破棄。
- **ネイティブカーネル試作**: Rust による GPU compute / QUIC・TCP / メモリプール / protocol（`kernel-native/`）。
- **仕様 / 実装**: `akasha-link/PROTOCOL.md`, `akasha-link/client-web/`, `akasha-link/kernel-native/`

## 12. IR ネイティブ化 —「自然言語を生成しない AI」への道（将来技術）

- 閉じた語彙（AILSA）は出力空間が極小（約 100〜300 トークン）・正準化で学習データ激減・厳密パーサーで検証可能 → **蒸留（LLM 生成ペアで小モデルを QLoRA 学習）に最適**。
- **文法制約付き生成（Constrained Decoding）**: 生成の各ステップで「次に来てよいトークン」を文法で制約（`CALL` の次は `SLOT_*` / `RETURN` のみ）。モデルが NL を生成する「隙」が構造的になくなる。
- **3 技術**: 出力語彙の制限 + 文法制約付き生成 + OS が NL を担当（対話は Front-end / Back-end Compiler の仕事）。将来は「IR を話す専門モデル」と「NL を話す汎用モデル」を同居させる。
- **仕様**: `AI_IR_MODEL.md`, `AI_TOOLCHAIN.md`, `training/finetune.py`

## 13. Assistant オーケストレーション設定 — roles / uniform と複数 API プロバイダ（v1.5）

- **フリート構成モード（fleetMode）** を導入:
  - `roles`（既定）: General=選択モデル ×1 + Reasoning=Pro/カスタム ×(N-1) の**役割別フォールバック**（タスク分類で空応答時に次のモデルへ委譲）。
  - `uniform`: 選択モデルで **N 台を並列同時呼び出し**。実行時は（プロバイダ, モデル）のユニーク組み合わせだけ `Promise.allSettled` で並列に投げ、最初の有効応答を採用（同一 API への無駄な多重リクエストは統合）。UI の監視画面は「deepseek-v4-flash ×15」のように設定どおりの構成を表示。
- **複数 API プロバイダ登録（providers）**: 各エントリが `{ name, apiBase, apiKey, model }` を持ち、**モデル名の一致するプロバイダへ自動ルーティング**。DeepSeek / OpenAI / Anthropic 等を混在させて 1 つのオーケストレーションに参加させられる。旧 `apiKey/apiBase` とは双方向同期（後方互換）。
- **実証**: uniform で「Flash ×15」構成・並列実行（重複統合 1 ノード + 採用 trace）を実 API で確認。golden 43 / selftest / tools-test / audit-test / sandbox-test / memory 34 passed 全パス。

## 14. Agent 安全化 — 監査ログ（署名付き証跡）・safe-mode（PR 隔離）・サンドボックス

- **監査ログ（audit.ts）**: 全ツール呼び出し・モデル応答を **append-only JSONL + HMAC-SHA256 署名**で `~/.arcasha/agent-audit/` に保存（git 外）。応答本文は sha256 ハッシュのみ保存し機密を出さない。`verifyAuditLine` で改ざん検知が可能。
- **safe-mode（pr-workflow.ts）**: 実ワークスペース編集を **作業ブランチ（arcasha/agent/<ts>）へ commit + push** に載せる。SWE-bench 評価（一時サンドボックス）は直接編集のまま維持し、`/api/agent`（Coding Agent）は `ARCASHA_AGENT_SAFE_MODE=1` で有効化。人間のレビューと CI を待ってマージする。
- **サンドボックスインタフェース（sandbox.ts）**: run_command を隔離実行する共通インタフェース。DirectSandboxRunner は shell:false（引数分離）でシェルインジェクションを防止。将来 Docker / Firecracker コンテナへ委譲するプラグイン点を用意。
- **実証**: audit-test（署名検証・改ざん検知）/ sandbox-test（引数分離・タイムアウト）ALL PASS。

## 15. フィードバック学習ループ（👍/👎 + 理由）と KV キャッシュ最適化（deepseek-harness 手法の適合）

- **人間フィードバックの保存（feedback.ts）**: Chat 応答の 👍/👎 と任意の理由を **append-only JSONL**（`~/.arcasha/assistant-feedback.jsonl`）に保存。スレッド・モデル・モード・プロンプト・応答・トークン消費・キャッシュヒット量をメタとして同録し、「どの応答がなぜ良かった/悪かったか」を AI 最適化の学習データにできる。監視画面に good/bad/total の統計カードを常設。
- **KV キャッシュ最適化の 3 原則（server.ts answerThread）**: DeepSeek のプロンプトキャッシュは「リクエスト先頭からの完全一致プレフィックス」にのみヒットする。旧方式は毎ターン内容が変わる合成メッセージを先頭に置くため、実質ヒット率 0 だった。そこで:
  1. **system を全ターン不変の詳細プロンプト**（役割・スタイル・制約を明文化、数百 tokens）に固定しキャッシュの土台にする。
  2. **保存済み会話履歴を「生のまま」順番に送る**（content は一切加工しない。メッセージ単位でのみ古い方からドロップ）。ターン間でプレフィックス一致が維持される。
  3. **可変情報（記憶・知識・現在の質問）は履歴の後ろ**（キャッシュ境界の外）にまとめて置く。
- **ヒット率の可視化**: 実 API の `usage.prompt_cache_hit_tokens` を捕捉し、Chat メタに `🧠 cache N%`（ライブ時・履歴復元時とも）、監視タブに直近 100 コールの hit rate / cached / prompt カード、呼び出しリスト各行に `🧠 N cached` を表示。
- **実証（実 API）**: 同一スレッド連続ターンで ターン3: **27% → ターン4: 34%** とヒット率が上昇（履歴が伸びるほどキャッシュ対象が拡大）。旧方式（動的合成メッセージ）では連続ターンでも 0% だった。

---

## 全体まとめ（革新技術マップ）

| # | 革新技術 | 既存との差別化（何が新しいか） | 主要な実証 |
|---|---|---|---|
| 1 | **AI OS パラダイム** | モデルを大きくせず OS 層で知能を管理 | — |
| 2 | **AILSA / AILSM（ISA / SSA-IR）** | AI の思考・状態・記憶を実行可能 IR で表現 | selftest 89 件 / golden 43 |
| 3 | **AVM（AI 仮想記憶）** | コンテキスト窓拡大ではなくデマンドページング | トークン **96.5% 削減**・精度 100% |
| 4 | **Reasoning Runtime** | 推論（仮説の生成・淘汰・統合）を OS で明示管理 | Reasoning 57% → 93% |
| 5 | **Executive / Meta Executive** | 探索途中の戦略切替・推論予算・設定の学習 | 品質 0.50 → 0.71 / レイテンシ +37ms |
| 6 | **Expert Evolution** | Expert の split / merge / retire | — |
| 7 | **Attachment / Thinking Modes** | 知能 = オプションのカーネルモジュール、思考予算を可視化 | Robot **30.3fps** / Coding +80% |
| 8 | **Explainable / Policy Learning** | なぜ推論構成を選んだか説明・再生・学習 | debate 期待ゲイン +22% → +40% |
| 9 | **Cognitive Graph / Oasis** | タスクごとの動的チーム編成 + OS 運用知識の蓄積 | 成功率 67% → 93% / 9.99x スケール |
| 10 | **検証の科学（Sim/Real 分離）** | 数値の偽装をしない再現可能な評価 | 外部ベンチ 27% → 95% |
| 11 | **Belief-Driven + LinUCB-Shadow** | シャドウによるフル情報バンディット + 能力推定 | capability 除去で Regret +37.6% |
| 12 | **Akasha Wire Protocol** | JSON 禁止の 48B バイナリ + ゼロコピー WebGPU | — |
| 13 | **IR ネイティブ / NL を生成しない AI** | 文法制約付き生成 + 蒸留 | —（ロードマップ） |
| 14 | **Assistant オーケストレーション設定** | roles（役割別フォールバック）/ uniform（同一モデル N 並列）+ 複数 API プロバイダ混在 | uniform で Flash×N 並列を実 API 確認 |
| 15 | **Agent 安全化（監査・PR・サンドボックス）** | 署名付き監査ログ + safe-mode（ブランチ隔離）+ サンドボックス IF | audit/sandbox test ALL PASS |
| 16 | **フィードバック学習ループ + KV キャッシュ最適化** | 👍/👎+理由を JSONL 保存（AI 最適化データ）+ 固定 SYSTEM・生履歴でプレフィックス一致を維持 | 実 API でヒット率 0% → 27% → 34% |

> **全体を貫く主張**: ArcAsha の独自性は「AI を強くする研究」ではなく「**AI Runtime を設計する研究**」にある。
> 蓄積されるのは LLM の重みではなく **OS の運用知識（チーム編成・推論経路・Executive 判断・Lesson）** であり、モデルを再学習しなくても OS 全体は経験とともに賢くなる。

