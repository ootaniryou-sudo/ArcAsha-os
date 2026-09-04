/**
 * AILSA ISA — 基本命令セット（Base ISA / AI版RISC-V）
 *
 * 閉じた語彙のうち、制御系の「命令」を定義する。
 * 唯一の権威は registry.json（Intel Manual）。ここはその高速ミラー。
 *
 * 命令フォーマット: Opcode(1byte) + Slot(任意) + Value(長さ前置)
 * スロット領域 (0x20–0x2F) は他カテゴリと排他なので、デコードは曖昧さなく進む。
 */

/** System Call オペコード（AI OS の syscall = AILSA 命令） */
export enum SyscallOpcode {
  EXECUTE = 0x80,
  SPAWN = 0x81,
  PLAN = 0x82,
  VERIFY = 0x83,
  REFLECT = 0x84,
  ROUTE = 0x85,
  MEMORY_STORE = 0x86,
  MEMORY_LOAD = 0x87,
  MEMORY_QUERY = 0x88,
  MEMORY_DELETE = 0x89,
  UPDATE_CAPABILITY = 0x8a,
}

/** Base ISA 制御命令（0x30–0x3E）＋ 拡張制御命令（0x8B–0x92: 分散/教訓/観測/検証） */
export enum Opcode {
  CALL = 0x30,
  RETURN = 0x31,
  STORE = 0x32,
  LOAD = 0x33,
  FAIL = 0x34,
  SUCCESS = 0x35,
  PLAN = 0x36,
  VERIFY = 0x37,
  DECOMPOSE = 0x38,
  DEPENDENCY = 0x39,
  PARALLEL = 0x3A,
  MERGE = 0x3B,
  SEARCH = 0x3C,
  RANK = 0x3D,
  FILTER = 0x3E,
  // ── 拡張制御（Base ISA 拡張領域 0x8B–0x92、registry v1.3.0+） ──
  NODE_SEND = 0x8b,
  NODE_RECV = 0x8c,
  BARRIER = 0x8d,
  REDUCE = 0x8e,
  LESSON_STORE = 0x8f,
  LESSON_RETRIEVE = 0x90,
  TRACE_POINT = 0x91,
  ASSERT = 0x92,
}

export const OPCODE_NAMES: Record<number, string> = {
  [Opcode.CALL]: 'CALL',
  [Opcode.RETURN]: 'RETURN',
  [Opcode.STORE]: 'STORE',
  [Opcode.LOAD]: 'LOAD',
  [Opcode.FAIL]: 'FAIL',
  [Opcode.SUCCESS]: 'SUCCESS',
  [Opcode.PLAN]: 'PLAN',
  [Opcode.VERIFY]: 'VERIFY',
  [Opcode.DECOMPOSE]: 'DECOMPOSE',
  [Opcode.DEPENDENCY]: 'DEPENDENCY',
  [Opcode.PARALLEL]: 'PARALLEL',
  [Opcode.MERGE]: 'MERGE',
  [Opcode.SEARCH]: 'SEARCH',
  [Opcode.RANK]: 'RANK',
  [Opcode.FILTER]: 'FILTER',
  [Opcode.NODE_SEND]: 'NODE_SEND',
  [Opcode.NODE_RECV]: 'NODE_RECV',
  [Opcode.BARRIER]: 'BARRIER',
  [Opcode.REDUCE]: 'REDUCE',
  [Opcode.LESSON_STORE]: 'LESSON_STORE',
  [Opcode.LESSON_RETRIEVE]: 'LESSON_RETRIEVE',
  [Opcode.TRACE_POINT]: 'TRACE_POINT',
  [Opcode.ASSERT]: 'ASSERT',
};

/** スロット領域（値を持つフィールド識別子）。命令オペコードと排他。 */
export const SLOT_MIN = 0x20;
export const SLOT_MAX = 0x2f;

/** バイトがスロット領域か（= その命令に属するスロットの開始） */
export function isSlotByte(b: number): boolean {
  return b >= SLOT_MIN && b <= SLOT_MAX;
}

/** Base ISA の制御命令か */
export function isBaseOpcode(op: number): boolean {
  return op >= Opcode.CALL && op <= Opcode.FILTER;
}
