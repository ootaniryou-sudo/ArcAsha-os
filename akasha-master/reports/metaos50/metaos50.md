# MetaOS 50 同時駆動 — deepseek-v4-flash

- kind: real-api（実 API 呼び出し・数値は偽装しない）
- 実行日時: 2026-08-27T13:59:53.458Z
- ノード: 50 体（仮想 DeepSeek API ノード）/ キャラバン 5（10台/組）/ 同時実行 50

## 結果

| 項目 | 値 |
|---|---|
| 完了時間 | 1886 ms |
| スループット | 26.51 task/s |
| 遅延 avg / p50 / p90 / p99 | 1487 / 1499 / 1715 / 1885 ms |
| 成功 / 失敗 | 50 / 0 |
| 正しさ（期待値 2X を回答） | 50 / 50 |
| OS 学習（CapabilityLearner） | 50 エキスパート |
| Stage-2 委譲 | 50 / 50 |
| 429/レート制限 | 0 回 |
| キャラバン分散 | {"caravan-0":10,"caravan-1":10,"caravan-2":10,"caravan-3":10,"caravan-4":10} |

## 検証（V1..V6）

- **v1**: ✅ PASS
- **v2**: ✅ PASS
- **v3**: ✅ PASS
- **v4**: ✅ PASS
- **v5**: ✅ PASS
- **v6**: ✅ PASS

## タスク別

| # | nodeId | caravan | expected | ok | verified | ms |
|---|---|---|---|---|---|---|
| 1 | api-deepseek-0 | caravan-0 | 2 | true | true | 1476 |
| 2 | api-deepseek-1 | caravan-0 | 4 | true | true | 1476 |
| 3 | api-deepseek-2 | caravan-0 | 6 | true | true | 1715 |
| 4 | api-deepseek-3 | caravan-0 | 8 | true | true | 1671 |
| 5 | api-deepseek-4 | caravan-0 | 10 | true | true | 1714 |
| 6 | api-deepseek-5 | caravan-0 | 12 | true | true | 1544 |
| 7 | api-deepseek-6 | caravan-0 | 14 | true | true | 1319 |
| 8 | api-deepseek-7 | caravan-0 | 16 | true | true | 1577 |
| 9 | api-deepseek-8 | caravan-0 | 18 | true | true | 1532 |
| 10 | api-deepseek-9 | caravan-0 | 20 | true | true | 1702 |
| 11 | api-deepseek-10 | caravan-1 | 22 | true | true | 1569 |
| 12 | api-deepseek-11 | caravan-1 | 24 | true | true | 1499 |
| 13 | api-deepseek-12 | caravan-1 | 26 | true | true | 1309 |
| 14 | api-deepseek-13 | caravan-1 | 28 | true | true | 1523 |
| 15 | api-deepseek-14 | caravan-1 | 30 | true | true | 1682 |
| 16 | api-deepseek-15 | caravan-1 | 32 | true | true | 1713 |
| 17 | api-deepseek-16 | caravan-1 | 34 | true | true | 1327 |
| 18 | api-deepseek-17 | caravan-1 | 36 | true | true | 1885 |
| 19 | api-deepseek-18 | caravan-1 | 38 | true | true | 1475 |
| 20 | api-deepseek-19 | caravan-1 | 40 | true | true | 1189 |
| 21 | api-deepseek-20 | caravan-2 | 42 | true | true | 1870 |
| 22 | api-deepseek-21 | caravan-2 | 44 | true | true | 1540 |
| 23 | api-deepseek-22 | caravan-2 | 46 | true | true | 1284 |
| 24 | api-deepseek-23 | caravan-2 | 48 | true | true | 1480 |
| 25 | api-deepseek-24 | caravan-2 | 50 | true | true | 1327 |
| 26 | api-deepseek-25 | caravan-2 | 52 | true | true | 1475 |
| 27 | api-deepseek-26 | caravan-2 | 54 | true | true | 1354 |
| 28 | api-deepseek-27 | caravan-2 | 56 | true | true | 1333 |
| 29 | api-deepseek-28 | caravan-2 | 58 | true | true | 1530 |
| 30 | api-deepseek-29 | caravan-2 | 60 | true | true | 1587 |
| 31 | api-deepseek-30 | caravan-3 | 62 | true | true | 1331 |
| 32 | api-deepseek-31 | caravan-3 | 64 | true | true | 1860 |
| 33 | api-deepseek-32 | caravan-3 | 66 | true | true | 1475 |
| 34 | api-deepseek-33 | caravan-3 | 68 | true | true | 1475 |
| 35 | api-deepseek-34 | caravan-3 | 70 | true | true | 1232 |
| 36 | api-deepseek-35 | caravan-3 | 72 | true | true | 1475 |
| 37 | api-deepseek-36 | caravan-3 | 74 | true | true | 1559 |
| 38 | api-deepseek-37 | caravan-3 | 76 | true | true | 1308 |
| 39 | api-deepseek-38 | caravan-3 | 78 | true | true | 1613 |
| 40 | api-deepseek-39 | caravan-3 | 80 | true | true | 1806 |
| 41 | api-deepseek-40 | caravan-4 | 82 | true | true | 1536 |
| 42 | api-deepseek-41 | caravan-4 | 84 | true | true | 1254 |
| 43 | api-deepseek-42 | caravan-4 | 86 | true | true | 1156 |
| 44 | api-deepseek-43 | caravan-4 | 88 | true | true | 951 |
| 45 | api-deepseek-44 | caravan-4 | 90 | true | true | 1272 |
| 46 | api-deepseek-45 | caravan-4 | 92 | true | true | 1227 |
| 47 | api-deepseek-46 | caravan-4 | 94 | true | true | 1502 |
| 48 | api-deepseek-47 | caravan-4 | 96 | true | true | 1474 |
| 49 | api-deepseek-48 | caravan-4 | 98 | true | true | 1509 |
| 50 | api-deepseek-49 | caravan-4 | 100 | true | true | 1676 |
