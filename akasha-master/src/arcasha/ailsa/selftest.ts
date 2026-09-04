/**
 * AILSA Phase 0 — セルフテスト（土台の完全性を検証）
 *
 * 実行: npx tsx src/arcasha/ailsa/selftest.ts
 */

import { Domain, Slot, Task, registry } from './vocab.js';
import { Opcode } from './opcode.js';
import { CODE, MATH, getDialect } from './dialect.js';
import { CodeOpcode, MathOpcode } from './dialect.js';
import { CodecError, Instruction, encodeVarint, MAX_VARINT_BYTES } from './encoder.js';
import { coerceSlotValue, decodeVarint } from './decoder.js';
import { compile, decode, encode, version } from './codec.js';
import { validateProgram } from './validator.js';

let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name} ${detail}`);
  }
}

function expectThrow(name: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ FAIL: ${name}（例外が投げられなかった）`);
  } catch (e) {
    console.log(`  ✓ ${name}（${(e as Error).message}）`);
  }
}

/** CodecError の送出を検証する（CodecError 以外の例外は失敗扱い） */
function expectCodecError(name: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ FAIL: ${name}（CodecError が投げられなかった）`);
  } catch (e) {
    if (e instanceof CodecError) {
      console.log(`  ✓ ${name}（${(e as Error).message}）`);
    } else {
      failed++;
      console.error(
        `  ✗ FAIL: ${name}（CodecError 以外の例外: ${(e as Error).constructor.name}: ${(e as Error).message}）`,
      );
    }
  }
}

console.log('═'.repeat(60));
console.log('  AILSA Phase 0 — Self Test');
console.log('═'.repeat(60));

// ── 1. Registry ──
console.log('\n[1] Registry');
const reg = registry();
check('バージョン 1.3.0', version() === '1.3.0', `got ${version()}`);
check('命令数 >= 85', reg.instructions.length >= 85, `got ${reg.instructions.length}`);
check('TASK_SOLVE=0x04', reg.instructions.some((e) => e.name === 'TASK_SOLVE' && e.opcode === 0x04));
check('DOMAIN_MATH=0x12', reg.instructions.some((e) => e.name === 'DOMAIN_MATH' && e.opcode === 0x12));
check('CALL=0x30', reg.instructions.some((e) => e.name === 'CALL' && e.opcode === 0x30));
check('GREP=0x56', reg.instructions.some((e) => e.name === 'GREP' && e.opcode === 0x56));
check('READ_FILE=0x57', reg.instructions.some((e) => e.name === 'READ_FILE' && e.opcode === 0x57));
check('EDIT_FILE=0x58', reg.instructions.some((e) => e.name === 'EDIT_FILE' && e.opcode === 0x58));
check('RUN_COMMAND=0x59', reg.instructions.some((e) => e.name === 'RUN_COMMAND' && e.opcode === 0x59));
check('NODE_SEND=0x8B', reg.instructions.some((e) => e.name === 'NODE_SEND' && e.opcode === 0x8b));
check('ASSERT=0x92', reg.instructions.some((e) => e.name === 'ASSERT' && e.opcode === 0x92));
check('SWE 4命令は code 方言', ['GREP', 'READ_FILE', 'EDIT_FILE', 'RUN_COMMAND'].every((n) => {
  const e = reg.instructions.find((x) => x.name === n);
  return e !== undefined && e.dialect === 'code' && e.category === 'code';
}));
check('拡張制御は base 方言', ['NODE_SEND', 'NODE_RECV', 'BARRIER', 'REDUCE', 'LESSON_STORE', 'LESSON_RETRIEVE', 'TRACE_POINT', 'ASSERT'].every((n) => {
  const e = reg.instructions.find((x) => x.name === n);
  return e !== undefined && e.dialect === 'base' && e.category === 'control';
}));

// ── 2. 語彙ミラーと整合 ──
console.log('\n[2] Vocabulary mirrors (enum ⇄ registry)');
check('Task.SOLVE = 0x04', Task.SOLVE === 0x04);
check('Slot.CONF = 0x23', Slot.CONF === 0x23);
check('Domain.MATH = 0x12', Domain.MATH === 0x12);
check('Opcode.CALL = 0x30', Opcode.CALL === 0x30);
check('Opcode.RETURN = 0x31', Opcode.RETURN === 0x31);
check('CodeOpcode.GREP = 0x56', CodeOpcode.GREP === 0x56);
check('CodeOpcode.RUN_COMMAND = 0x59', CodeOpcode.RUN_COMMAND === 0x59);
check('Opcode.NODE_SEND = 0x8B', Opcode.NODE_SEND === 0x8b);
check('Opcode.ASSERT = 0x92', Opcode.ASSERT === 0x92);

// ── 3. Dialect ──
console.log('\n[3] Dialect');
check('MathDialect supports CALL', MATH.supports(Opcode.CALL));
check('MathDialect supports EQ', MATH.supports(MathOpcode.EQ));
check('MathDialect rejects CLASS', !MATH.supports(CodeOpcode.CLASS));
check('CodeDialect supports CLASS', CODE.supports(CodeOpcode.CLASS));
check('CodeDialect supports GREP', CODE.supports(CodeOpcode.GREP));
check('CodeDialect supports READ_FILE', CODE.supports(CodeOpcode.READ_FILE));
check('CodeDialect supports EDIT_FILE', CODE.supports(CodeOpcode.EDIT_FILE));
check('CodeDialect supports RUN_COMMAND', CODE.supports(CodeOpcode.RUN_COMMAND));
check('MathDialect rejects GREP', !MATH.supports(CodeOpcode.GREP));
check('CodeDialect rejects EQ', !CODE.supports(MathOpcode.EQ));
check('getDialect(math) === MATH', getDialect('math') === MATH);

// ── 4. Encode / Decode roundtrip ──
console.log('\n[4] Codec roundtrip');
const prog: Instruction[] = [
  {
    opcode: Opcode.CALL,
    slots: [
      { slot: Slot.EXPERT, value: 'math' },
      { slot: Slot.TASK_ID, value: '35' },
      { slot: Slot.DOMAIN, value: 'math' },
    ],
  },
  { opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'x^2-4=0' }] },
  {
    opcode: Opcode.RETURN,
    slots: [
      { slot: Slot.TASK_ID, value: '35' },
      { slot: Slot.OUTPUT, value: 'x=2' },
      { slot: Slot.CONF, value: 0.92 },
    ],
  },
];
const bytes = encode(prog);
const decoded = decode(bytes);
check('バイト列が生成される', bytes.length > 0, `len=${bytes.length}`);
check('roundtrip 一致', JSON.stringify(decoded) === JSON.stringify(prog));
check('compile === encode', compile(prog).every((b, i) => b === bytes[i]));
check('CONF が number で復元', (decoded[2].slots?.find((s) => s.slot === Slot.CONF)?.value as number) === 0.92);

// 日本語もスロット値として可搬（CALL → RETURN の妥当なプログラム）
const jaBytes = encode([
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'reasoning' }, { slot: Slot.TASK_ID, value: '1' }] },
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '1' }, { slot: Slot.OUTPUT, value: 'AIです。' }] },
]);
const jaDecoded = decode(jaBytes);
check('日本語値の roundtrip', jaDecoded[1].slots?.find((s) => s.slot === Slot.OUTPUT)?.value === 'AIです。');

// registry v1.3.0: SWE（code 方言: GREP / READ_FILE / EDIT_FILE / RUN_COMMAND）の roundtrip
const sweProg: Instruction[] = [
  {
    opcode: Opcode.CALL,
    slots: [
      { slot: Slot.EXPERT, value: 'programming' },
      { slot: Slot.TASK_ID, value: '7' },
      { slot: Slot.DOMAIN, value: 'code' },
    ],
  },
  { opcode: CodeOpcode.GREP, slots: [{ slot: Slot.INPUT, value: 'TODO' }] },
  { opcode: CodeOpcode.READ_FILE, slots: [{ slot: Slot.INPUT, value: 'src/arcasha/swe/tools.ts' }] },
  { opcode: CodeOpcode.EDIT_FILE, slots: [{ slot: Slot.INPUT, value: 'TODO を FIXME に置換' }] },
  { opcode: CodeOpcode.RUN_COMMAND, slots: [{ slot: Slot.INPUT, value: 'npm run build' }] },
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '7' }] },
];
const sweBytes = encode(sweProg);
check('SWE 命令列がエンコードできる', sweBytes.length > 0, `len=${sweBytes.length}`);
check('SWE roundtrip 一致', JSON.stringify(decode(sweBytes)) === JSON.stringify(sweProg));

// registry v1.3.0: 拡張制御（分散 / 教訓 / 観測 / 検証）の roundtrip
const extProg: Instruction[] = [
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'general' }, { slot: Slot.TASK_ID, value: '8' }] },
  { opcode: Opcode.NODE_SEND, slots: [{ slot: Slot.INPUT, value: 'partial-1' }, { slot: Slot.TASK_ID, value: '8' }] },
  { opcode: Opcode.NODE_RECV, slots: [{ slot: Slot.OUTPUT, value: 'partial-2' }] },
  { opcode: Opcode.BARRIER },
  { opcode: Opcode.REDUCE, slots: [{ slot: Slot.INPUT, value: 'sum' }] },
  { opcode: Opcode.LESSON_STORE, slots: [{ slot: Slot.KEY, value: 'lesson-1' }, { slot: Slot.VALUE, value: 'check before edit' }] },
  { opcode: Opcode.LESSON_RETRIEVE, slots: [{ slot: Slot.KEY, value: 'lesson-1' }] },
  { opcode: Opcode.TRACE_POINT, slots: [{ slot: Slot.TRACE, value: 'phase-2' }] },
  { opcode: Opcode.ASSERT, slots: [{ slot: Slot.INPUT, value: 'result != null' }] },
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '8' }] },
];
const extBytes = encode(extProg);
check('拡張制御命令列がエンコードできる', extBytes.length > 0, `len=${extBytes.length}`);
check('拡張制御 roundtrip 一致', JSON.stringify(decode(extBytes)) === JSON.stringify(extProg));

// 不正バイト列は大声で失敗
expectThrow('切り詰めバイト列でエラー', () => decode(Uint8Array.from([0x30, 0x29, 0x05])));
expectThrow('不正 varint でエラー', () => decode(Uint8Array.from([0x30, 0x29, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])));

// ── 4.5. Varint エッジケース（乗算方式・32bit ビット演算非依存） ──
console.log('\n[4.5] Varint エッジケース');
function varintRoundtrip(name: string, n: number): void {
  const enc = encodeVarint(n);
  const dec = decodeVarint(enc, 0);
  check(`varint roundtrip ${name} (${n})`, dec.value === n && dec.next === enc.length);
}
varintRoundtrip('ゼロ', 0);
varintRoundtrip('1バイト境界', 127);
varintRoundtrip('2バイト境界', 128);
varintRoundtrip('2バイト最大', 16383);
varintRoundtrip('3バイト境界', 16384);
varintRoundtrip('4バイト最大', 2 ** 28 - 1);
varintRoundtrip('4バイト境界', 2 ** 28);
varintRoundtrip('32bit超（従来はビット演算で壊れる）', 2 ** 31);
varintRoundtrip('5バイト最大', 2 ** 35 - 1);
expectCodecError('5バイト上限超でエラー', () => encodeVarint(2 ** 35));
expectCodecError('負数でエラー', () => encodeVarint(-1));
expectCodecError('非整数でエラー', () => encodeVarint(1.5));
// decodeVarint の offset 検証も CodecError を確認
const enc128 = encodeVarint(128);
expectCodecError('offset 負数でエラー', () => decodeVarint(enc128, -1));
expectCodecError('offset 非整数でエラー', () => decodeVarint(enc128, 1.5));
expectCodecError('offset NaN でエラー', () => decodeVarint(enc128, NaN));

// ── 4.6. coerceSlotValue（valueType 変換・boolean 拒否分岐） ──
console.log('\n[4.6] coerceSlotValue（valueType 変換）');
check('boolean true を true に', coerceSlotValue('boolean', 'true') === true);
check('boolean false を false に', coerceSlotValue('boolean', 'false') === false);
expectCodecError('boolean に不正値でエラー', () => coerceSlotValue('boolean', 'yes'));
expectCodecError('boolean に空文字でエラー', () => coerceSlotValue('boolean', ''));
check('number 変換', coerceSlotValue('number', '42') === 42);
check('string はそのまま', coerceSlotValue('string', 'abc') === 'abc');
check('undefined はそのまま', coerceSlotValue(undefined, 'xyz') === 'xyz');

// MAX_VARINT_BYTES と varint 上限の整合（5 バイト = 2^35-1）
check('MAX_VARINT_BYTES=5', MAX_VARINT_BYTES === 5);

// ── 5. Validator ──
console.log('\n[5] Validator');
const call = (id: string): Instruction => ({
  opcode: Opcode.CALL,
  slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: id }],
});
const ret = (id: string): Instruction => ({
  opcode: Opcode.RETURN,
  slots: [{ slot: Slot.TASK_ID, value: id }, { slot: Slot.OUTPUT, value: 'ok' }],
});

check('CALL CALL CALL RETURN → valid', validateProgram([call('1'), call('2'), call('3'), ret('1')]).valid);
check('RETURN RETURN → invalid', !validateProgram([ret('1'), ret('2')]).valid);
check('未登録 opcode → invalid', !validateProgram([{ opcode: 0x99 }]).valid);
check('必須スロット不足 CALL → invalid', !validateProgram([{ opcode: Opcode.CALL }]).valid);
check('許可外スロット → invalid', !validateProgram([{ opcode: Opcode.CALL, slots: [{ slot: Slot.TASK_ID, value: '1' }, { slot: Slot.EXPERT, value: 'm' }, { slot: Slot.REASON, value: 'x' }] }]).valid);
check('空プログラム → invalid', !validateProgram([]).valid);

// CONF 範囲外の単体検証
const confBad = validateProgram([
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '1' }, { slot: Slot.CONF, value: 1.5 }] },
]);
check('CONF=1.5 → invalid', !confBad.valid, confBad.issues.map((i) => i.message).join(' | '));

// エンコード前に検証が走る（codec は不正を絶対に通さない）
expectThrow('不正プログラムを encode → 例外', () => encode([ret('1'), ret('2')]));

// ── 6. 決定論 ──
console.log('\n[6] Determinism');
const bytesA = encode(prog);
const bytesB = encode(prog);
check('同じ入力 → 同じバイト列', bytesA.every((b, i) => b === bytesB[i]));

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — AILSA Phase 0 土台は完全一致・決定論・検証可能');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
