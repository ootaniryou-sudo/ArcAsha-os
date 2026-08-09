/**
 * AILSA Decoder — バイト列 → 構造化命令（100% 決定論）
 *
 * 不正バイト列は決して黙って解釈しない。CodecError を投げて大声で失敗する
 * （= 絶対に壊れない土台）。
 */

import { isSlotByte } from './opcode.js';
import { valueTypeOf, ValueType } from './vocab.js';
import { CodecError, Instruction, MAX_VARINT_BYTES, SlotValue } from './encoder.js';

export function decodeVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let multiplier = 1; // 各バイトの桁: 1, 128, 128^2, ...
  let i = offset;
  for (let count = 0; count < MAX_VARINT_BYTES; count++) {
    if (i >= bytes.length) throw new CodecError(`varint が途中で切れている (offset ${offset})`);
    const b = bytes[i];
    i++;
    // 乗算方式（encoder と対称）。最初のバイトが最下位7ビット。
    // 32bit ビット演算に依存せず 2^31 超も正しく復元できる。
    value += (b & 0x7f) * multiplier;
    multiplier *= 128;
    if ((b & 0x80) === 0) return { value, next: i };
  }
  throw new CodecError(`varint が ${MAX_VARINT_BYTES} バイトを超えた (offset ${offset})`);
}

function typedValue(slot: number, raw: string): string | number | boolean {
  const t: ValueType | undefined = valueTypeOf(slot);
  if (t === 'number') return Number(raw);
  if (t === 'boolean') {
    // 不正バイト列から 'true'/'false' 以外が来ても黙って false にしない（防御的）。
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new CodecError(`boolean スロット 0x${slot.toString(16)} に不正値 "${raw}"`);
  }
  return raw;
}

function decodeInstruction(bytes: Uint8Array, offset: number): { instr: Instruction; next: number } {
  if (offset >= bytes.length) throw new CodecError('命令の先頭が不足');
  const opcode = bytes[offset];
  let i = offset + 1;
  const slots: SlotValue[] = [];
  while (i < bytes.length && isSlotByte(bytes[i])) {
    const slot = bytes[i];
    i++;
    const len = decodeVarint(bytes, i);
    i = len.next;
    if (i + len.value > bytes.length) {
      throw new CodecError(`スロット 0x${slot.toString(16)} の値が切れている (offset ${i})`);
    }
    const raw = new TextDecoder().decode(bytes.subarray(i, i + len.value));
    i += len.value;
    slots.push({ slot, value: typedValue(slot, raw) });
  }
  return { instr: { opcode, slots: slots.length > 0 ? slots : undefined }, next: i };
}

/** バイト列 → 命令列（空バイト列は空プログラムとして妥当） */
export function decodeProgram(bytes: Uint8Array): Instruction[] {
  const out: Instruction[] = [];
  let i = 0;
  while (i < bytes.length) {
    const { instr, next } = decodeInstruction(bytes, i);
    if (next === i) throw new CodecError('デコードが進行しない（内部バグ）');
    out.push(instr);
    i = next;
  }
  return out;
}
