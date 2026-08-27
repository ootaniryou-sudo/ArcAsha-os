# MetaOS 50 同時駆動 — deepseek-v4-flash

- kind: real-api（実 API 呼び出し・数値は偽装しない）
- 実行日時: 2026-08-27T14:24:31.159Z
- ノード: 50 体（仮想 DeepSeek API ノード）/ キャラバン 5（10台/組）/ 同時実行 50

## 結果

| 項目 | 値 |
|---|---|
| 完了時間 | 2147 ms |
| スループット | 23.29 task/s |
| 遅延 avg / p50 / p90 / p99 | 1422 / 1403 / 1693 / 2146 ms |
| 成功 / 失敗 | 50 / 0 |
| 正しさ（期待値 2X を回答） | 50 / 50 |
| OS 学習（CapabilityLearner） | 50 エキスパート |
| Stage-2 委譲 | 50 / 50 |
| 429/レート制限 | 0 回（全試行の観測回数） |
| キャラバン分散 | {"caravan-0":10,"caravan-1":10,"caravan-2":10,"caravan-3":10,"caravan-4":10} |
| ルーティング（caravanRoute sweep） | 200 キー × キャラバン → 到達可能ノード 50/50（{"caravan-0":200,"caravan-1":200,"caravan-2":200,"caravan-3":200,"caravan-4":200}） |
| ノードメトリクス | シミュレーション値（source=sim）— 実測は API 呼び出しレイテンシ・スループットのみ |

## 検証（V1..V6）

- **v1**: ✅ PASS
- **v2**: ✅ PASS
- **v3**: ✅ PASS
- **v4**: ✅ PASS
- **v5**: ✅ PASS
- **v6**: ✅ PASS

> 数値の分類: API 呼び出しレイテンシ・スループットは kind=real-api の実測。
> ノードメトリクス（battery / RTT / 電力）は決定論シミュレーション値（source=sim）であり実測ではない。

## タスク別

| # | nodeId | caravan | expected | ok | verified | ms |
|---|---|---|---|---|---|---|
| 1 | api-deepseek-0 | caravan-0 | 2 | true | true | 1667 |
| 2 | api-deepseek-1 | caravan-0 | 4 | true | true | 1594 |
| 3 | api-deepseek-2 | caravan-0 | 6 | true | true | 2146 |
| 4 | api-deepseek-3 | caravan-0 | 8 | true | true | 1538 |
| 5 | api-deepseek-4 | caravan-0 | 10 | true | true | 1413 |
| 6 | api-deepseek-5 | caravan-0 | 12 | true | true | 1693 |
| 7 | api-deepseek-6 | caravan-0 | 14 | true | true | 2085 |
| 8 | api-deepseek-7 | caravan-0 | 16 | true | true | 1539 |
| 9 | api-deepseek-8 | caravan-0 | 18 | true | true | 2083 |
| 10 | api-deepseek-9 | caravan-0 | 20 | true | true | 1418 |
| 11 | api-deepseek-10 | caravan-1 | 22 | true | true | 1403 |
| 12 | api-deepseek-11 | caravan-1 | 24 | true | true | 1243 |
| 13 | api-deepseek-12 | caravan-1 | 26 | true | true | 1225 |
| 14 | api-deepseek-13 | caravan-1 | 28 | true | true | 1430 |
| 15 | api-deepseek-14 | caravan-1 | 30 | true | true | 1102 |
| 16 | api-deepseek-15 | caravan-1 | 32 | true | true | 1330 |
| 17 | api-deepseek-16 | caravan-1 | 34 | true | true | 1398 |
| 18 | api-deepseek-17 | caravan-1 | 36 | true | true | 1279 |
| 19 | api-deepseek-18 | caravan-1 | 38 | true | true | 1448 |
| 20 | api-deepseek-19 | caravan-1 | 40 | true | true | 1538 |
| 21 | api-deepseek-20 | caravan-2 | 42 | true | true | 1227 |
| 22 | api-deepseek-21 | caravan-2 | 44 | true | true | 1256 |
| 23 | api-deepseek-22 | caravan-2 | 46 | true | true | 1256 |
| 24 | api-deepseek-23 | caravan-2 | 48 | true | true | 1538 |
| 25 | api-deepseek-24 | caravan-2 | 50 | true | true | 1208 |
| 26 | api-deepseek-25 | caravan-2 | 52 | true | true | 1619 |
| 27 | api-deepseek-26 | caravan-2 | 54 | true | true | 1538 |
| 28 | api-deepseek-27 | caravan-2 | 56 | true | true | 1538 |
| 29 | api-deepseek-28 | caravan-2 | 58 | true | true | 1537 |
| 30 | api-deepseek-29 | caravan-2 | 60 | true | true | 1538 |
| 31 | api-deepseek-30 | caravan-3 | 62 | true | true | 1414 |
| 32 | api-deepseek-31 | caravan-3 | 64 | true | true | 1079 |
| 33 | api-deepseek-32 | caravan-3 | 66 | true | true | 1708 |
| 34 | api-deepseek-33 | caravan-3 | 68 | true | true | 1686 |
| 35 | api-deepseek-34 | caravan-3 | 70 | true | true | 1297 |
| 36 | api-deepseek-35 | caravan-3 | 72 | true | true | 1333 |
| 37 | api-deepseek-36 | caravan-3 | 74 | true | true | 1243 |
| 38 | api-deepseek-37 | caravan-3 | 76 | true | true | 1351 |
| 39 | api-deepseek-38 | caravan-3 | 78 | true | true | 1079 |
| 40 | api-deepseek-39 | caravan-3 | 80 | true | true | 1376 |
| 41 | api-deepseek-40 | caravan-4 | 82 | true | true | 1273 |
| 42 | api-deepseek-41 | caravan-4 | 84 | true | true | 1210 |
| 43 | api-deepseek-42 | caravan-4 | 86 | true | true | 1538 |
| 44 | api-deepseek-43 | caravan-4 | 88 | true | true | 1447 |
| 45 | api-deepseek-44 | caravan-4 | 90 | true | true | 1324 |
| 46 | api-deepseek-45 | caravan-4 | 92 | true | true | 1061 |
| 47 | api-deepseek-46 | caravan-4 | 94 | true | true | 1111 |
| 48 | api-deepseek-47 | caravan-4 | 96 | true | true | 1280 |
| 49 | api-deepseek-48 | caravan-4 | 98 | true | true | 1213 |
| 50 | api-deepseek-49 | caravan-4 | 100 | true | true | 1272 |
