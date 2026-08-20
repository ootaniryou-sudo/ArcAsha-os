/**
 * Coding Harness — 公開 API（H0〜H2）
 */
export type { Harness } from './harness.js';

export type {
  HarnessTask,
  HarnessExecuteOptions,
  HarnessResult,
  HarnessExecutionError,
} from './types.js';
export {
  HarnessTaskError,
  HarnessCancelledError,
  HarnessInfrastructureError,
} from './types.js';

export type {
  HarnessEvent,
  HarnessStartedEvent,
  HarnessCompletedEvent,
  HarnessFailedEvent,
  HarnessMessageEvent,
  HarnessCancelledEvent,
} from './events.js';
export { assertTerminalState, isHarnessStarted, isHarnessTerminal } from './events.js';

export { executeOnce } from './execute-once.js';

export type { HarnessOutcome } from './consume.js';
export { consumeHarness } from './consume.js';

// H1: Native Harness
export { NativeHarness, suggestFunctionName, generateCode } from './native.js';

// H2-A/B: DeepSeek Harness Adapter（dsh ACP）
export { DeepSeekHarnessAdapter, DSH_VERSION } from './deepseek.js';
export type { DshAdapterOptions } from './deepseek.js';

// Registry（Native フォールバック）
export { createHarness, resolveHarness } from './registry.js';
export type { HarnessKind } from './registry.js';
