# Plugin Architecture — ArcAsha を「交換可能なモジュール」にする

> 決定記録（2026-08-30）。`RESEARCH_PLAN.md`（検証フェーズ移行）に続く、Phase 2（Boundary Fix）の実装方針。
> **方針: 「本命に組み込むために作る」のではなく、「単独で価値を証明でき、なおかつ後から本命にプラグインとして接続できるように作る」。**

## 1. 3 プロジェクトとプラグイン境界

```
                 本命 Orchestrator（将来の別リポジトリ）
                        │
              ┌─────────┴─────────┐
              │   Plugin / Adapter │
              └─────────┬─────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
     ArcAsha        Akasha-Link    その他 Backend
   Intelligence     Execution
     Runtime          Fabric
```

| モジュール | プラグインとして提供するもの |
|---|---|
| **ArcAsha**（`akasha-master`） | 「**思考・推論・記憶をどう実行するか**」→ Intelligence Runtime 契約（`src/arcasha/plugin/runtime-contract.ts`） |
| **Akasha-Link**（`akasha-link`） | 「**計算をどのノード・デバイスで実行するか**」→ PROTOCOL.md / 実行ファブリック（Phase 3 で 48B 統一） |
| **本命 Orchestrator**（将来） | 「**何を・いつ・どこで・どのプラグインに実行させるか**」を決めるホスト |

## 2. 大事なこと: 「プラグインとして完成」ではなく「プラグインになれるよう独立」

- 今すぐ `ArcAsha → Future Orchestrator` の依存関係を作らない。
- 各モジュールは**単独で起動・検証・価値証明**できる。
- 公開 API / Runtime Contract を安定させ、**後から Adapter を書く**だけで本命に接続できる状態にする。
- 研究段階で失敗した機能は本命に持ち込まない。**成功した機能だけ**を将来統合する。

## 3. ArcAsha のプラグイン境界（実装済み）

`akasha-master/src/arcasha/plugin/`

| ファイル | 役割 |
|---|---|
| `model-fleet.ts` | タスク分類 → モデルルーティング（Flash/Pro）の共通基盤。チャットサーバーと Runtime が共有 |
| `runtime-contract.ts` | **IntelligenceRuntime 契約**（`submit` / `capabilities` / `status` / `dispose`）+ 既存実装のアダプタ |
| `selftest.ts` | 契約が mock モード（API 不要）で独立動作することを検証 |

```ts
// 本命 Orchestrator 側の Adapter が接続する面（イメージ。API キー設定時: Pro（推論）／未設定時: Mock）
const rt = createIntelligenceRuntime();
await rt.submit({ task: 'x^2+2x+1=0 を解いて', maxTokens: 512 });
// → RuntimeResult { ok, answer, kind: 'math', expert: 'Pro（推論）', memory: {...}, trace: [...] }
//   ※ DEEPSEEK_API_KEY 未設定時は expert='Mock（推論）'・model='mock' で動作する
```

- **依存の向き**: ArcAsha は Orchestrator を知らない。`createIntelligenceRuntime()` は外部依存なしで単独動作（API キーなしでも mock で動く）。
- **能力の公開**: `capabilities()` が「何ができるか」を返すので、本命側がプラグインを発見・選択できる。

## 4. 各プロジェクトの「契約」を安定させる（Phase 2 / 3）

| モジュール | 安定させる契約 | 状態 |
|---|---|---|
| ArcAsha | `plugin/runtime-contract.ts`（IntelligenceRuntime） | ✅ 実装済み（本 PR） |
| ArcAsha 内部 | Harness は Adapter 層に隔離（DeepSeek への直接依存を作らない） | 継続 |
| Akasha-Link | `PROTOCOL.md`（48B header）を唯一の実装に統一 | ⏳ Phase 3（20B legacy 削除） |

## 5. 将来の統合（今はやらない）

```
Future Orchestrator
       ├── ArcAsha Adapter   ← createIntelligenceRuntime() をラップ
       └── Akasha-Link Adapter ← 実行ファブリック API をラップ
```

- 統合は**検証が完了した後**に、新規リポジトリで行う。
- コピペ（`cp -r`）は禁止。安定 API / Runtime Contract 経由でのみ接続する。
