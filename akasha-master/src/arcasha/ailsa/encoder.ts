/**
 * AILSA Encoder — 構造化命令 → バイト列（100% 決定論）
 *
 * フォーマット（AILSA_ISA.md §4）:
 *   [Opcode 1byte] { [Slot 1byte] [varint len] [UTF-8 value] }*
 *
 * スロット領域 (0x20–0x2F) はオペコード領域と排他なので、
 * デコーダは曖昧さなくスロットの開始を判定できる。
 */

import { valueTypeOf, ValueType } from './vocab.js';

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

export interface SlotValue {
  slot: number;
  value: string | number | boolean;
}

export interface Instruction {
  opcode: number;
  slots?: SlotValue[];
}

export function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** LEB128 varint の最大バイト数（AILSA 仕様: 最大 5 バイト = 2^35-1） */
export const MAX_VARINT_BYTES = 5;

/**
 * 非負整数 → LEB128 varint。
 *
 * 乗算方式（v % 128 / Math.floor(v / 128)）を使い、JS の 32bit ビット演算
 * （`v >>>= 7` 等）に依存しない。これにより 2^31 を超える安全整数も
 * 正しくエンコードできる。上限は仕様どおり 5 バイト（2^35-1）。
 */
export function encodeVarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new CodecError(`varint には非負の安全整数が必要: ${n}`);
  }
  if (n >= 2 ** (7 * MAX_VARINT_BYTES)) {
    throw new CodecError(
      `varint は ${MAX_VARINT_BYTES} バイト（最大 ${2 ** (7 * MAX_VARINT_BYTES) - 1}）まで: ${n}`,
    );
  }
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Uint8Array.from(out);
}

/** スロットの valueType に応じた正準文字列へ変換（決定論） */
function canonicalValue(slot: number, value: string | number | boolean): string {
  const t: ValueType | undefined = valueTypeOf(slot);
  if (typeof value === 'string') {
    if (t === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new CodecError(`数値スロットに非数値: 0x${slot.toString(16)} = "${value}"`);
      return String(n);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CodecError(`数値スロットに非有限値: ${value}`);
    if (t === 'string') return String(value);
    return String(value);
  }
  // boolean
  if (t === 'number') throw new CodecError(`数値スロットに boolean: 0x${slot.toString(16)}`);
  return value ? 'true' : 'false';
}

/** 1命令 → バイト列 */
export function encodeInstruction(instr: Instruction): Uint8Array {
  if (instr.opcode < 0 || instr.opcode > 0xff) {
    throw new CodecError(`opcode 範囲外: 0x${instr.opcode.toString(16)}`);
  }
  const chunks: number[] = [instr.opcode];
  for (const sv of instr.slots ?? []) {
    if (sv.slot < 0 || sv.slot > 0xff) {
      throw new CodecError(`slot 範囲外: 0x${sv.slot.toString(16)}`);
    }
    chunks.push(sv.slot);
    const body = encodeUtf8(canonicalValue(sv.slot, sv.value));
    chunks.push(...encodeVarint(body.length));
    chunks.push(...body);
  }
  return Uint8Array.from(chunks);
}

/** 命令列 → バイト列 */
export function encodeProgram(program: Instruction[]): Uint8Array {
  const chunks: Uint8Array[] = program.map(encodeInstruction);
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
