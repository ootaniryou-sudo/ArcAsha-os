/**
 * Coding Harness — 公開 API（H0）
 */
export type { Harness } from './harness.js';

export type {
  HarnessTask,
  HarnessExecuteOptions,
  HarnessResult,
  HarnessExecutionError,
} from './types.js';
export { HarnessTaskError, HarnessInfrastructureError } from './types.js';

export type {
  HarnessEvent,
  HarnessStartedEvent,
  HarnessCompletedEvent,
  HarnessFailedEvent,
} from './events.js';
export { assertTerminalState, isHarnessStarted, isHarnessTerminal } from './events.js';

export { executeOnce } from './execute-once.js';

export type { HarnessOutcome } from './consume.js';
export { consumeHarness } from './consume.js';
