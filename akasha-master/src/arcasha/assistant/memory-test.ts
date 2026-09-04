/**
 * ArcAsha Assistant — 長期記憶層 + 記憶抽出ルールのユニットテスト
 *
 * 実行: npx tsx src/arcasha/assistant/memory-test.ts
 * 検証: スレッド CRUD / 永続化（再ロード）/ facts / knowledge / コンテキスト合成 / 記憶抽出
 */
import { LongTermMemory, guessTitle } from './long-term-memory.js';
import { extractRememberAll } from './remember.js';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function main(): Promise<void> {
  // 並列実行でも衝突しないよう mkdtemp で専用ディレクトリを作る
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcasha-mem-test-'));
  const mem = new LongTermMemory(dir);
  await mem.load();

  console.log('\n🧠 LongTermMemory ユニットテスト');

  // 1) スレッド CRUD
  const t = mem.createThread({ mode: 'casual' });
  ok(mem.getThread(t.id)?.id === t.id, 'スレッド作成');
  mem.appendMessage(t.id, { role: 'user', content: '私の名前はテストです' });
  mem.appendMessage(t.id, { role: 'assistant', content: 'こんにちは' });
  ok(mem.getThread(t.id)?.messages.length === 2, 'メッセージ追加');
  ok(t.title !== '新しい会話' && t.title.length > 0, `タイトル自動生成: ${t.title}`);

  // 2) facts
  mem.addFact('ユーザーの名前はテストさん', 'user');
  mem.addFact('ユーザーはコーヒーが好き', 'preference');
  ok(mem.listFacts().length === 2, 'fact 追加');
  ok(mem.listFacts('user').length === 1, 'カテゴリ絞り込み');

  // 3) knowledge
  mem.addKnowledge('勤務先', '株式会社サンプルに勤務');
  ok(mem.listKnowledge().length === 1, 'knowledge 追加');

  // 4) コンテキスト合成（クエリと部分一致した facts を含む）
  const ctx = mem.buildMemoryContext('コーヒーの話をしよう', t.id);
  ok(ctx.includes('コーヒー'), 'クエリ関連 fact をコンテキストに含む');
  ok(ctx.includes('直近の会話'), '直近会話を含む');
  // マッチングの回帰検知: factMax=1 で正確にマッチした fact が選ばれること（recent は 0 で切る）
  const ctx2 = mem.buildMemoryContext('コーヒー', t.id, { recent: 0, factMax: 1, knowMax: 0 });
  ok(ctx2.includes('ユーザーはコーヒーが好き') && !ctx2.includes('直近の会話'), 'factMax=1 でクエリ一致 fact だけを選ぶ');

  // 5) 永続化（新インスタンスで再ロード）
  await mem.flush();
  const mem2 = new LongTermMemory(dir);
  await mem2.load();
  ok(mem2.listThreads().length === 1, '再ロードでスレッド保持');
  ok(mem2.listFacts().length === 2, '再ロードで facts 保持');
  ok(mem2.listKnowledge().length === 1, '再ロードで knowledge 保持');
  ok(mem2.getThread(t.id)?.messages.length === 2, '再ロードでメッセージ保持');

  // 6) 削除（メモリ上の変化だけでなく永続化まで検証）
  const f = mem2.listFacts()[0];
  mem2.deleteFact(f.id);
  ok(mem2.listFacts().length === 1, 'fact 削除');
  mem2.deleteThread(t.id);
  ok(mem2.listThreads().length === 0, 'スレッド削除');
  // 削除後にディスクへ書き出し、再ロードしても消えたままであること
  await mem2.flush();
  const mem3 = new LongTermMemory(dir);
  await mem3.load();
  ok(mem3.listFacts().length === 1 && !mem3.listFacts().some((x) => x.id === f.id), '削除した fact が再ロード後も消えている');
  ok(mem3.listThreads().length === 0, '削除したスレッドが再ロード後も消えている');

  // 7) guessTitle
  ok(guessTitle([{ role: 'user', content: 'あいうえお'.repeat(10) }]).endsWith('…'), '長文タイトル省略');

  // 8) 記憶抽出ルール（remember.ts）
  console.log('\n🔎 記憶抽出ルール テスト');
  const r1 = extractRememberAll('私の名前は太郎です', () => false);
  ok(r1.some((x) => x.text === 'ユーザーの名前は太郎さん' && x.category === 'user'), '名前抽出: 私の名前は太郎');
  const r2 = extractRememberAll('私は花子と呼んでください', () => false);
  ok(r2.some((x) => x.text === 'ユーザーの名前は花子さん'), '名前抽出: 花子と呼んで');
  const r3 = extractRememberAll('私の名前は太郎です。ラーメンが好きです。猫が苦手です', () => false);
  ok(r3.some((x) => x.text === 'ユーザーはラーメンが好き' && x.category === 'preference'), '好み抽出: ラーメンが好き');
  ok(r3.some((x) => x.text === 'ユーザーは猫が苦手' && x.category === 'preference'), '苦手抽出: 猫が苦手');
  const r4 = extractRememberAll('2+2は何ですか', () => false);
  ok(r4.length === 0, '非自己紹介文では抽出しない');
  // 重複チェック
  const seen = new Set<string>();
  const dupCheck = (key: string): boolean => {
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
  const r5a = extractRememberAll('コーヒーが好き', dupCheck);
  const r5b = extractRememberAll('コーヒーが好き', dupCheck);
  ok(r5a.length === 1 && r5b.length === 0, '重複した好みは抽出しない');
  // P1 回帰: 「私は猫が好き」で主語が「私」にならず「猫」を捕捉する
  const r6 = extractRememberAll('私は猫が好き', () => false);
  ok(r6.some((x) => x.text === 'ユーザーは猫が好き'), '一人称接頭「私は〜が好き」で主語を正しく捕捉');
  ok(!r6.some((x) => x.text.includes('私')), '主語に「私」を含まない');
  // P2 回帰: 名前の文字（すず / かなで）をクリーニングで壊さない
  const r7 = extractRememberAll('私の名前はすずです', () => false);
  ok(r7.some((x) => x.text === 'ユーザーの名前はすずさん'), '名前「すず」が文字欠けしない');
  const r8 = extractRememberAll('私の名前はかなでです', () => false);
  ok(r8.some((x) => x.text === 'ユーザーの名前はかなでさん'), '名前「かなで」が文字欠けしない');
  // 同一メッセージ内の重複は 1 回だけ抽出
  const r9 = extractRememberAll('コーヒーが好きです。コーヒーが好きです', () => false);
  ok(r9.filter((x) => x.text === 'ユーザーはコーヒーが好き').length === 1, '同一メッセージ内の重複は 1 回だけ');

  // 後片付け（書き込みチェーンの完了を待ってから削除）
  await new Promise((r) => setTimeout(r, 50));
  await mem2.flush();
  await fs.rm(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed / ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
