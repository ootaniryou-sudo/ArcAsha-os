# Akasha-Link — Distributed Inference / Tensor Transport Engine

> エッジデバイス（WebGPU）を活用した、超低遅延の「分散推論・テンソル伝送エンジン」。
> **AI の認知や思考は一切扱わない。**「サーバーから降ってきたテンソルを、スマホの WebGPU で
> いかに速く計算して送り返すか」だけに特化した純粋な高速インフラ。

## 役割

- **プロジェクトA（本プロジェクト）**: 分散推論 — WebGPU オーバーヘッド削減 / 5G・Wi-Fi 環境での通信圧縮 / ゼロコピーバイナリ中継
- プロジェクトB「**ArcAsha-Core / MetaOS**」: モデル非依存の AI オーケストレーション OS（`akasha-master/`）が、この Akasha-Link をエッジ実装として利用する

## 構成

```text
akasha-link/
├── PROTOCOL.md        # Akasha Wire Protocol（48B ヘッダ + f32[] ペイロードのバイナリワイヤ。両プロジェクトの契約）
├── client-web/        # WebGPU 推論（browser edge node: main.ts / webgpu-core.ts / worker.ts / worker-inference.js）
├── kernel-native/     # ネイティブカーネル試作（Rust: GPU compute / QUIC・TCP / メモリプール / protocol / platform）
└── README.md
```

## ワイヤプロトコル（PROTOCOL.md）

JSON はデータプレーンで禁止。全てのメッシュトラフィックは単一の `ArrayBuffer`
（固定 48 バイトヘッダ + 任意の `Float32Array` ペイロード）で転送され、そのまま WebGPU へアップロードできる。

> 注: 現行の `client-web/src/worker.ts` は従来の 20 バイト層ヘッダ（txId + layerId）を
> 使用しています。PROTOCOL.md の 48 バイト形式への移行は別途追跡します。

| 項目 | 値 |
|---|---|
| MAGIC | `0x414B5348` (`AKSH`) |
| HEADER_SIZE | 48 バイト |
| 最大ペイロード | 65,536 floats（256 KiB） |
| 主要コマンド | `REGISTER` / `COMPUTE_TASK` / `RESULT` / `FAILOVER` / `RELAY` / `TOKEN_OUT` |

詳細は [PROTOCOL.md](./PROTOCOL.md) を参照。

## ビルド・テスト

```bash
# WebGPU クライアント（browser edge node）
(cd client-web && npm install && npm run build)

# ネイティブカーネル（Rust）
(cd kernel-native && cargo check && cargo test)

# ルートから一括
npm run build:link && npm run test:link
```

## ロードマップ（独立プロジェクト化）

- [x] モノレポから切り出し（`akasha-link/` に集約・git 履歴保持）
- [x] プロジェクトルート（本 README / package.json / CI）
- [ ] Phase 3: git リポジトリの物理分割（filter-repo、ユーザー確認後に実施）
