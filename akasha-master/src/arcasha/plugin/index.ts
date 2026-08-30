/**
 * ArcAsha plugin — Future Orchestrator へ接続するためのプラグイン境界
 *
 *  - model-fleet.ts      : タスク分類 → モデルルーティング（Flash/Pro）の共通基盤
 *  - runtime-contract.ts: Intelligence Runtime 契約 + 既存実装のアダプタ
 */
export { buildFleet, classifyTask, routeExpert } from './model-fleet.js';
export type { FleetExpert, TaskKind, BuildFleetOptions } from './model-fleet.js';
export { createIntelligenceRuntime } from './runtime-contract.js';
export type {
  IntelligenceRuntime,
  RuntimeRequest,
  RuntimeResult,
  RuntimeStatus,
  RuntimeCapability,
  CreateRuntimeOptions,
} from './runtime-contract.js';
