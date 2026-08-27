# Contributing to Akasha-OS

Thank you for your interest in contributing to the world's first democratised distributed AI operating system! 🚀

## Code of Conduct

This project adheres to a simple principle: **build together, with respect.** We welcome contributors from all backgrounds, skill levels, and time zones. Harassment, gatekeeping, and big-tech-pilled behaviour will not be tolerated.

## How to Contribute

### 1. Write a Plugin (easiest!)

The fastest way to contribute is to write an **Expert Plugin**. Implement the `AkashaExpertPlugin` interface, pick a domain, and submit it:

```typescript
import type { AkashaExpertPlugin } from 'akasha-os';

const myPlugin: AkashaExpertPlugin = {
  metadata: { /* ... */ },
  execute: async (inputTensor: Float32Array): Promise<Float32Array> => {
    // Your model inference here
  },
};
```

See [`examples/`](examples/) for ready-to-copy templates.

### 2. Improve the Core

| Layer | Language | Directory | Good first issues |
|-------|----------|-----------|-------------------|
| Master Orchestrator (Project B) | TypeScript | `akasha-master/` | Improve routing, add cluster strategies |
| Native Kernel (Project A) | Rust | `akasha-link/kernel-native/` | Optimise GPU shaders, platform support |
| Browser Client (Project A) | TypeScript | `akasha-link/client-web/` | Dashboard UI, WebGPU perf tuning |

> このリポジトリは 2 つの独立プロジェクトを内包します:
> **Project A: Akasha-Link**（`akasha-link/` = 分散推論 / テンソル伝送エンジン）と
> **Project B: ArcAsha-Core / MetaOS**（`akasha-master/` = AI オーケストレーション OS）。
> 共有契約は `akasha-link/PROTOCOL.md`。

### 3. Report Bugs / Propose Features

Use the [issue templates](.github/ISSUE_TEMPLATE/):
- [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Plugin Proposal](.github/ISSUE_TEMPLATE/plugin_proposal.md)
- [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md)

## Development Setup

```bash
git clone https://github.com/ootaniryou-sudo/Akasha-OS.git
cd Akasha-OS

# Project B: ArcAsha-Core (TypeScript)
cd akasha-master && npm install && npm run build

# Project A: Akasha-Link
#   Kernel (Rust)
cd ../akasha-link/kernel-native && cargo check
#   Client (Browser, WebGPU)
cd ../akasha-link/client-web && npm install && npm run build
```

## Pull Request Process

> **ブランチ戦略**: 新機能・変更は必ず feature ブランチを経由して main へマージします（main への直接コミットは原則禁止）。CodeRabbit による自動レビューが PR ごとに走ります。

1. `main` から feature ブランチを作成します:

   ```bash
   git checkout main && git pull
   git checkout -b feat/<概要>        # 例: feat/api-parallel-bench
   ```

2. 開発・テスト・コミットを feature ブランチ上で行います。

3. 動作確認を feature ブランチ上で実行します（PR 作成前に必須・リポジトリ直下から）:

   - `npm run build`
   - `npm run selftest`
   - `npm run golden` / `npm run ailsa:selftest`
   - `cargo check`（akasha-link/kernel-native）

4. プッシュして PR を作成します:

   ```bash
   git push origin feat/<概要>
   ```

5. PR には [テンプレート](.github/pull_request_template.md) に従って概要・変更内容・動作確認（build / selftest の実測結果）を記載します。

6. CodeRabbit のレビューに対応し、必要なら修正を追加コミットします。

7. レビュー完了後、main へ **squash merge** し、ローカルも更新します:

   ```bash
   git checkout main && git pull
   ```

### CodeRabbit

- PR 作成時に [CodeRabbit](https://www.coderabbit.ai/) が自動レビューします（`.coderabbit.yaml` で設定）。
- レビューコメントは PR の会話に自動投稿され、`@coderabbitai` にメンションすることで対話・修正提案を受けられます。

## Community Channels

- **GitHub Discussions**: For Q&A, ideas, and show-and-tell.
- **Issues**: For bugs and feature tracking.
- **Plugin Marketplace** (coming soon): Discover community-built experts.

---

> *「知識は、たとえそれが砂粒のように小さくとも、繋がれば砂漠となり、やがて全世界を覆う。」*
> —— スメール・アーカーシャシステム運用理念（『原神』世界設定より）
