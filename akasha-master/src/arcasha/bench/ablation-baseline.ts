/**
 * Ablation Baseline（Phase 4 — Scientific Validation）
 * 「ArcAsha のどの技術が本当に効いているか」を、同一タスク・同一モデルで
 * 4 構成を比較して証明する。
 *
 *   ① Baseline LLM    : モデル単体（OS なし・素のプロンプト）
 *   ② Baseline + AVM  : AVM が明示知識から必要ページだけを供給
 *   ③ Baseline + Exec : Executive（aiosExecute: compile → CALL → learner）のみ
 *   ④ Full ArcAsha    : AVM + Executive の組み合わせ
 *
 * 公平性: ①〜④すべて同じモデル（deepseek-v4-flash）。ルーティング（Pro）は
 * 別レバーとして混ぜない（モデル差を導入しない）。数値は kind=real-api の実測。
 *
 * 測定: 正確性（数値/キーワード検証） / レイテンシ / トークン使用量（実 API） /
 *       コスト（概算） / 成功率（非空応答率）
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { ExpertHub } from '../experts/registry.js';
import { buildFleet } from '../plugin/model-fleet.js';
import { initAiOs, aiosExecute } from '../ailsm/aios.js';
import { AvmWorkspace } from '../chat/avm-telemetry.js';

// ─── タスクセット（検証可能な正答を持つ・実 API で解かせる）──────────
export interface AblationTask {
  id: string;
  category: 'math' | 'knowledge';
  task: string;
  reference: string;   // 正答（数値 or キーワード）
  context?: string;    // AVM に渡す知識（knowledge タスクのみ）
  altNumbers?: number[]; // このタスクでのみ許容する追加の数値正答（例: k26 の 365.25）
}

export const ABLATION_TASKS: AblationTask[] = [
  // ── 数学（コンテキストなし: Executive / パイプラインの寄与を見る）──
  { id: 'm1', category: 'math', task: 'バナナ 3 本（1 本 100 円）とりんご 2 個（1 個 150 円）を買った。合計はいくら？', reference: '600' },
  { id: 'm2', category: 'math', task: '1 日 8 時間働いて 3 日間働いた。総労働時間は何時間？', reference: '24' },
  { id: 'm3', category: 'math', task: 'クラスに 30 人いて、そのうち 40% が女子。女子は何人？', reference: '12' },
  { id: 'm4', category: 'math', task: '時速 60km で 2 時間半走った。距離は何 km？', reference: '150' },
  { id: 'm5', category: 'math', task: '定価 2500 円の商品を 20% 引きで買った。支払額はいくら？', reference: '2000' },
  { id: 'm6', category: 'math', task: '1 年は 52 週。毎週 10 時間勉強すると年間何時間？', reference: '520' },
  // ── 知識 QA（コンテキストあり: AVM の検索・供給の寄与を見る）──
  {
    id: 'k1', category: 'knowledge',
    task: 'ArcAsha で数式の処理はどのエキスパートが担当しますか？',
    reference: 'math',
    context: 'ArcAsha は AI オペレーティングシステムであり、モデル自体は変更しない。OS 層が AVM（仮想メモリ）で必要ページだけをエキスパートへ供給する。検索は search エキスパート、数式は math エキスパート、コードは code エキスパートが担当する。AVM はコンテキストを固定サイズページに分割し、HOT/WARM/COLD の階層で管理する。',
  },
  {
    id: 'k2', category: 'knowledge',
    task: 'DeepSeek V4 で、max_tokens を小さくすると回答が空になる原因は？',
    reference: 'トークン',
    context: 'DeepSeek V4 は推論モデルで、応答は reasoning_content（思考）と content（最終回答）に分離される。max_tokens を小さくすると思考にトークン予算を使い切り、content が空になることがある。対処は max_tokens を十分に取ること、または reasoning_content をフォールバックとして使うこと。',
  },
  {
    id: 'k3', category: 'knowledge',
    task: 'アムステルダムは何という国の首都？',
    reference: 'オランダ',
    context: 'アムステルダムはオランダの首都であり、運河と自転車で有名である。人口は約 90 万人で、首都機能はハーグに一部置かれている。',
  },
  {
    id: 'k4', category: 'knowledge',
    task: '富士山の標高は何メートル？',
    reference: '3776',
    context: '富士山の標高は 3776 メートルで、日本一高い山である。山梨県と静岡県にまたがり、世界文化遺産にも登録されている。',
  },
  {
    id: 'k5', category: 'knowledge',
    task: 'ラマン分光法は物質の何を観測する手法？',
    reference: '分子振動',
    context: 'ラマン分光法は物質の分子振動を観測する分光手法で、鉱物同定・材料評価・創薬などに広く使われる。レーザー光の非弾性散乱を測定する。',
  },
  {
    id: 'k6', category: 'knowledge',
    task: '光が太陽から地球まで届くのにかかる時間は？',
    reference: '8分',
    context: '光の速度は秒速約 30 万キロメートル。太陽から地球までの距離は約 1 億 5000 万キロメートルで、光では約 8 分かかる。',
  },
];

/**
 * 本命タスクセット（50 問）: 数学 20 + 知識 30。
 * 正答は問題文に含まれないことを assertTaskIntegrity が保証する（エコーで正解になるのを防ぐ）。
 * 知識タスクには AVM が供給する context（正答を含む明示知識）を付与する。
 */
export const ABLATION_TASKS_50: AblationTask[] = [
  ...ABLATION_TASKS,
  // ── 数学（追加 m7–m20）──
  { id: 'm7', category: 'math', task: '7 と 8 の積はいくつ？', reference: '56' },
  { id: 'm8', category: 'math', task: '定価 4000 円の商品を 15% 引きで買った。支払額はいくら？', reference: '3400' },
  { id: 'm9', category: 'math', task: '3.5 キロメートルは何メートル？', reference: '3500' },
  { id: 'm10', category: 'math', task: '三角形の内角の和は何度？', reference: '180' },
  { id: 'm11', category: 'math', task: '2 の 10 乗はいくつ？', reference: '1024' },
  { id: 'm12', category: 'math', task: '1 ダースは 12 個。5 ダースは何個？', reference: '60' },
  { id: 'm13', category: 'math', task: '定価 1000 円の商品を 3 割引きで買った。支払額はいくら？', reference: '700' },
  { id: 'm14', category: 'math', task: '時速 50km で 2 時間走った。距離は何 km？', reference: '100' },
  { id: 'm15', category: 'math', task: '連続する 3 つの偶数の和が 30 のとき、最小の偶数はいくつ？', reference: '8' },
  { id: 'm16', category: 'math', task: '1 週間は何時間？', reference: '168' },
  { id: 'm17', category: 'math', task: '五角形の内角の和は何度？', reference: '540' },
  { id: 'm18', category: 'math', task: '25% を小数で表すといくつ？', reference: '0.25' },
  { id: 'm19', category: 'math', task: '4, 9, 11 の平均はいくつ？', reference: '8' },
  { id: 'm20', category: 'math', task: '直角を挟む 2 辺が 3cm と 4cm の直角三角形の斜辺の長さは？', reference: '5' },
  // ── 知識 QA（追加 k7–k30・正答を含む context を付与）──
  {
    id: 'k7', category: 'knowledge',
    task: '日本の首都はどこ？', reference: '東京',
    context: '日本の首都は東京で、政令指定都市の一つ。政治・経済・文化の中心地であり、人口は約 1400 万人に達する。',
  },
  {
    id: 'k8', category: 'knowledge',
    task: '世界一高い山エベレストがある山系は？', reference: 'ヒマラヤ',
    context: 'エベレスト（標高 8848 メートル）はヒマラヤ山脈に属し、ネパールと中国（チベット）の国境にある。',
  },
  {
    id: 'k9', category: 'knowledge',
    task: '太陽系で最も大きい惑星は？', reference: '木星',
    context: '木星は太陽系最大の惑星で、質量は他の全惑星を合わせたものより大きい。ガス惑星に分類される。',
  },
  {
    id: 'k10', category: 'knowledge',
    task: 'アメリカ合衆国の通貨の単位は？', reference: 'ドル',
    context: 'アメリカ合衆国の通貨は US ドルで、国際的な基軸通貨として広く使われている。補助単位はセント。',
  },
  {
    id: 'k11', category: 'knowledge',
    task: '面積が世界で最も大きい国は？', reference: 'ロシア',
    context: 'ロシアは面積が世界最大の国で、約 1710 万平方キロメートル。ユーラシア大陸をまたぐ。',
  },
  {
    id: 'k12', category: 'knowledge',
    task: '元素記号 Pb は何という元素？', reference: '鉛',
    context: '元素記号 Pb は鉛を表す（ラテン語 plumbum に由来）。密度が高く、古くから配管や蓄電池に使われる。',
  },
  {
    id: 'k13', category: 'knowledge',
    task: '画家ピカソが生まれた国は？', reference: 'スペイン',
    context: 'パブロ・ピカソはスペインのマラガで生まれ、後にフランスで活躍した。キュビスムの創始者として知られる。',
  },
  {
    id: 'k14', category: 'knowledge',
    task: '作曲家ベートーヴェンが生まれた国は？', reference: 'ドイツ',
    context: 'ルートヴィヒ・ヴァン・ベートーヴェンはドイツのボンで生まれた。交響曲第 9 番「合唱付き」で知られる。',
  },
  {
    id: 'k15', category: 'knowledge',
    task: 'ナイル川は何という海に流れ込む？', reference: '地中海',
    context: 'ナイル川はアフリカ最長の河川で、北へ流れて地中海に注ぐ。エジプトの文明を育んだ。',
  },
  {
    id: 'k16', category: 'knowledge',
    task: '科学者ガリレオ・ガリレイが生まれた国は？', reference: 'イタリア',
    context: 'ガリレオ・ガリレイはイタリアのピサで生まれた。望遠鏡による天体観測と地動説の支持で知られる。',
  },
  {
    id: 'k17', category: 'knowledge',
    task: '世界で最も深い海溝は？', reference: 'マリアナ',
    context: 'マリアナ海溝は世界で最も深い海溝で、最深部はチャレンジャー海淵と呼ばれ約 1 万 1000 メートル。',
  },
  {
    id: 'k18', category: 'knowledge',
    task: 'ハチミツを作る昆虫は？', reference: 'ミツバチ',
    context: 'ミツバチは花の蜜を集めてハチミツを作る社会性昆虫で、養蜂の対象にもなる。',
  },
  {
    id: 'k19', category: 'knowledge',
    task: 'カナダの首都はどこ？', reference: 'オタワ',
    context: 'カナダの首都はオタワで、オンタリオ州に位置する。最大都市はトロントで、首都ではない。',
  },
  {
    id: 'k20', category: 'knowledge',
    task: 'オーストラリアの首都はどこ？', reference: 'キャンベラ',
    context: 'オーストラリアの首都はキャンベラで、シドニーとメルボルンの間に計画都市として建設された。',
  },
  {
    id: 'k21', category: 'knowledge',
    task: 'ブラジルの首都はどこ？', reference: 'ブラジリア',
    context: 'ブラジルの首都はブラジリアで、1960 年に内陸部へ遷都された計画都市。最大都市はサンパウロ。',
  },
  {
    id: 'k22', category: 'knowledge',
    task: 'スイスの首都はどこ？', reference: 'ベルン',
    context: 'スイスの首都はベルンで、連邦議会や政府機関が置かれる。最大都市はチューリッヒ。',
  },
  {
    id: 'k23', category: 'knowledge',
    task: '人類が打ち上げた最初の人工衛星は？', reference: 'スプートニク',
    context: 'スプートニク 1 号は 1957 年にソ連が打ち上げた人類初の人工衛星で、地球周回軌道に乗った。',
  },
  {
    id: 'k24', category: 'knowledge',
    task: '人類で初めて月面に立った宇宙飛行士は？', reference: 'アームストロング',
    context: 'ニール・アームストロングは 1969 年のアポロ 11 号で人類として初めて月面に降り立った。',
  },
  {
    id: 'k25', category: 'knowledge',
    task: 'マラリアを媒介する蚊の一種は？', reference: 'ハマダラカ',
    context: 'ハマダラカ属の蚊がマラリア原虫を媒介する。ハマダラカは夜間に吸血し、マラリアの主要な感染経路となる。',
  },
  {
    id: 'k26', category: 'knowledge',
    task: '地球が太陽の周りを一周するのに要する日数は？', reference: '365',
    altNumbers: [365.25], // 「365.25日」というより精密な正解も受理する（このタスク限定）
    context: '地球の公転周期は約 365 日で、これが 1 年の長さの基準になっている。実際は約 365.25 日。',
  },
  {
    id: 'k27', category: 'knowledge',
    task: '1 年が 366 日になる年を何と呼ぶ？', reference: 'うるう年',
    context: 'うるう年は 2 月 29 日が追加され 366 日になる年で、4 年に 1 度（ただし 100 で割れて 400 で割れない年は除く）訪れる。',
  },
  {
    id: 'k28', category: 'knowledge',
    task: '世界で最初に鉄道が開通した国は？', reference: 'イギリス',
    context: 'イギリスで 1825 年にストックトン・アンド・ダーリントン鉄道が開通し、世界初の鉄道となった。',
  },
  {
    id: 'k29', category: 'knowledge',
    task: 'ギザのピラミッドがある国は？', reference: 'エジプト',
    context: 'ギザの三大ピラミッドはエジプトのカイロ近郊にあり、世界遺産に登録されている。',
  },
  {
    id: 'k30', category: 'knowledge',
    task: '世界遺産マチュ・ピチュがある国は？', reference: 'ペルー',
    context: 'マチュ・ピチュはペルーのアンデス山脈にあるインカ帝国の遺跡で、世界遺産に登録されている。',
  },
];

// ─── コスト概算（USD / 1M トークン。DeepSeek 料金の概算・変更されうる）──
const PRICE_IN_PER_MT = 0.28;
const PRICE_OUT_PER_MT = 0.42;

export type AblationConfigId = 'baseline' | 'avm' | 'executive' | 'full';

export interface AblationRow {
  config: AblationConfigId;
  name: string;
  tasks: number;
  runs: number;
  success: number;
  successRate: number;   // 非空応答率
  pass: number;
  accuracy: number;      // 正答率
  avgLatencyMs: number;
  avgTokens: number;
  estCostUsd: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
}

export interface AblationStats {
  /** Baseline（AVM OFF）vs +AVM（AVM ON）の McNemar 検定（タスク×run のペア） */
  mcnemarAvm: {
    n: number;          // 不一致ペア数（b + c）
    b: number;          // Baseline のみ誤答・AVM のみ正答
    c: number;          // Baseline のみ正答・AVM のみ誤答
    pValue: number;     // 両側正確二項検定の p 値
    significant: boolean; // p < 0.05
  };
}

export interface AblationResult {
  kind: 'real-api';
  model: string;
  runs: number;
  rows: AblationRow[];
  perTask: {
    config: AblationConfigId;
    taskId: string;
    category: string;
    ok: number;        // 非空応答だった run 数
    verified: number;  // 正答だった run 数
    runs: number;
    ms: number;        // 平均レイテンシ
    promptTokens: number;   // 平均
    completionTokens: number; // 平均
    text: string;
    error?: string;
  }[];
  stats: AblationStats;
  note: string;
}

// ─── 検証（数値 or キーワード・正規化）─────────────────────────────
function extractNumbers(s: string): number[] {
  const cleaned = s.replace(/,/g, ''); // 「3,776」→「3776」
  const out: number[] = [];
  for (const m of cleaned.match(/\d+(?:\.\d+)?/g) ?? []) {
    const n = Number(m);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** キーワード比較用の正規化（空白・助詞「の」・読点/括弧を除去） */
function normalizeKw(s: string): string {
  return s.toLowerCase().replace(/[\sの、。・（）()]/g, '');
}

function verify(task: AblationTask, text: string): boolean {
  const out = (text ?? '').trim();
  if (out === '') return false;
  const refNum = extractNumbers(task.reference)[0];
  if (refNum !== undefined) {
    // 数値の正答: 応答に同一数値が含まれるか（単位付き回答・カンマ区切りに対応）
    const nums = extractNumbers(out);
    if (nums.includes(refNum)) return true;
    // タスク固有の許容代替値のみ明示的に受理（例: k26 は「365.25日」というより精密な正解を許容）。
    // 他タスクの pass / accuracy / McNemar 集計には一切影響しない。
    if (task.altNumbers && task.altNumbers.some((a) => nums.includes(a))) return true;
    return false;
  }
  // キーワード正答: 助詞・空白を正規化して包含判定（「分子振動」vs「分子の振動」を許容）
  const kw = normalizeKw(task.reference);
  return kw !== '' && normalizeKw(out).includes(kw);
}

/**
 * タスクの健全性検査: 正答（数値/キーワード）が問題文に含まれていないことを保証する。
 * 含まれているとモデルが問題文をエコーするだけで正解になり、検証が無意味になる。
 */
function assertTaskIntegrity(tasks: AblationTask[]): void {
  for (const t of tasks) {
    const refNum = extractNumbers(t.reference)[0];
    const allNums = [...(refNum !== undefined ? [refNum] : []), ...(t.altNumbers ?? [])];
    for (const rn of allNums) {
      if (extractNumbers(t.task).includes(rn)) {
        throw new Error(
          `ablation: タスク ${t.id} の正答（${rn}）が問題文に含まれます。エコーで正解になるため問題文を修正してください`,
        );
      }
    }
    if (refNum === undefined) {
      const kw = normalizeKw(t.reference);
      if (kw !== '' && normalizeKw(t.task).includes(kw)) {
        throw new Error(
          `ablation: タスク ${t.id} の正答キーワード（${t.reference}）が問題文に含まれます。エコーで正解になるため問題文を修正してください`,
        );
      }
    }
  }
}

// ─── 統計（McNemar 検定: 対応のある 2 値データ）─────────────────────
function lnFact(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/** McNemar の両側正確 p 値（b = AVM のみ正答, c = Baseline のみ正答）。p = 2 × Bin(n,0.5) の下側確率 */
function mcnemarExactP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  const lnN = lnFact(n);
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(lnN - lnFact(i) - lnFact(n - i) - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

// ─── 実行 ───────────────────────────────────────────────────────────
export async function runAblationBaseline(
  opts: { tasks?: AblationTask[]; maxTokens?: number; verbose?: boolean; runs?: number } = {},
): Promise<AblationResult> {
  const tasks = opts.tasks ?? ABLATION_TASKS_50;
  if (tasks.length === 0) throw new Error('ablation: タスクが空です（tasks に 1 件以上を指定してください）');
  assertTaskIntegrity(tasks);
  // runs は正の安全な整数であることを最終検証境界として強制する
  const runsRaw = opts.runs ?? 1;
  if (!Number.isSafeInteger(runsRaw) || runsRaw < 1) {
    throw new Error(`ablation: runs は正の安全な整数（1 以上）である必要があります（指定値: ${runsRaw}）`);
  }
  const runs = runsRaw;
  const maxTokens = opts.maxTokens ?? 256;
  const hub = new ExpertHub();
  const fleet = buildFleet(hub, { verbose: opts.verbose ?? false });
  const flash = fleet.find((e) => e.role === 'general')!;
  const nodeId = flash.nodeId;
  const model = flash.model;
  // mock モデル（API キー未設定）では real-api 計測にならないため明示的に拒否する
  if (model === 'mock' || model.startsWith('mock-')) {
    throw new Error(
      `ablation: 実モデル（${model}）で実行できません。DEEPSEEK_API_KEY が設定されていないため buildFleet が mock を登録しました。.env を確認して再実行してください（mock での計測は real-api と偽装しないため拒否します）`,
    );
  }

  const aios = initAiOs({
    listNodes: () => hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
    // 計測の公平性のためキャッシュを迂回（同一プロンプトが 2 構成で呼ばれても実 API を毎回叩く）
    generate: async (id, p, m = maxTokens) => hub.generateNoCache(id, String(p), Number(m) || maxTokens),
  });

  const record = (): { promptTokens: number; completionTokens: number } =>
    hub.lastApiUsage ? { promptTokens: hub.lastApiUsage.promptTokens, completionTokens: hub.lastApiUsage.completionTokens } : { promptTokens: 0, completionTokens: 0 };

  /** ① Baseline: 素のプロンプトでモデル単体（キャッシュなし） */
  const baseline = async (t: AblationTask) => {
    const t0 = Date.now();
    const text = String((await hub.generateNoCache(nodeId, t.task, maxTokens)) ?? '').trim();
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  /** AVM が知識から必要ページを供給したプロンプトを組み立てる（per-task workspace = 分離） */
  const avmPrompt = (t: AblationTask) => {
    const w = new AvmWorkspace();
    let snippet = '';
    if (t.context) {
      w.storeContext('知識', t.context, 'user');
      const kloads = w.searchKnowledge(t.task, 2, 'search');
      snippet = kloads.map((k) => k.loadedText).join('\n').slice(0, 600);
    }
    return [t.task, snippet ? `\n\n[参照知識]\n${snippet}` : ''].join('');
  };

  /** ② Baseline + AVM: 明示知識から必要ページだけ供給してモデルへ（キャッシュなし） */
  const avm = async (t: AblationTask) => {
    const t0 = Date.now();
    const text = String((await hub.generateNoCache(nodeId, avmPrompt(t), maxTokens)) ?? '').trim();
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  /** ③ Baseline + Executive: aiosExecute（compile → CALL → learner）のみ（AVM なし） */
  const executive = async (t: AblationTask) => {
    const t0 = Date.now();
    const ex = await aiosExecute(aios, t.task, nodeId, { forceDelegate: true, maxTokens });
    const text = ex.result !== null && ex.result !== undefined ? String(ex.result).trim() : '';
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  /** ④ Full ArcAsha: AVM 供給 + Executive パイプライン（同一モデル） */
  const full = async (t: AblationTask) => {
    const t0 = Date.now();
    const ex = await aiosExecute(aios, avmPrompt(t), nodeId, { forceDelegate: true, maxTokens });
    const text = ex.result !== null && ex.result !== undefined ? String(ex.result).trim() : '';
    const u = record();
    return { text, ms: Date.now() - t0, ...u };
  };

  const configs: { id: AblationConfigId; name: string; run: (t: AblationTask) => Promise<{ text: string; ms: number; promptTokens: number; completionTokens: number }> }[] = [
    { id: 'baseline', name: '① Baseline LLM', run: baseline },
    { id: 'avm', name: '② +AVM', run: avm },
    { id: 'executive', name: '③ +Executive', run: executive },
    { id: 'full', name: '④ Full ArcAsha', run: full },
  ];

  const perTask: AblationResult['perTask'] = [];
  const rows: AblationRow[] = [];
  const n = tasks.length;
  const samples = n * runs;
  // AVM ON/OFF の対応ペア（Baseline と AVM は同一タスク順・同一 run 順で整列される）
  const baselineOutcomes: boolean[] = [];
  const avmOutcomes: boolean[] = [];

  for (const cfg of configs) {
    if (opts.verbose) console.log(`\n▸ ${cfg.name}（${n} tasks × ${runs} runs）`);
    let pass = 0, success = 0, totalMs = 0, promptT = 0, compT = 0;
    for (const t of tasks) {
      let okCount = 0, verCount = 0, sumMs = 0, sumPt = 0, sumCt = 0;
      let lastText = '', lastError: string | undefined;
      for (let run = 0; run < runs; run++) {
        const t0 = Date.now();
        let text = '', ms = 0, pt = 0, ct = 0;
        try {
          const r = await cfg.run(t);
          ms = r.ms;
          text = r.text;
          pt = r.promptTokens;
          ct = r.completionTokens;
          lastText = text;
        } catch (e) {
          // 失敗時も実測の経過時間を記録する（ms: 0 にしない）
          ms = Date.now() - t0;
          lastError = String(e).slice(0, 120);
          if (opts.verbose) console.log(`  ${t.id}#${run}: ⚠ ${String(e).slice(0, 80)}`);
        }
        const ok = text !== '';
        const verified = ok && verify(t, text);
        if (ok) okCount++;
        if (verified) verCount++;
        sumMs += ms;
        sumPt += pt;
        sumCt += ct;
        if (cfg.id === 'baseline') baselineOutcomes.push(verified);
        else if (cfg.id === 'avm') avmOutcomes.push(verified);
        if (opts.verbose) console.log(`  ${t.id}#${run}: ${verified ? '✅' : '❌'} ${ms}ms ${(pt + ct)}tok "${text.slice(0, 40)}"`);
      }
      success += okCount;
      pass += verCount;
      totalMs += sumMs;
      promptT += sumPt;
      compT += sumCt;
      perTask.push({
        config: cfg.id,
        taskId: t.id,
        category: t.category,
        ok: okCount,
        verified: verCount,
        runs,
        ms: Math.round(sumMs / runs),
        promptTokens: Math.round(sumPt / runs),
        completionTokens: Math.round(sumCt / runs),
        text: lastText.slice(0, 120),
        ...(lastError ? { error: lastError } : {}),
      });
    }
    const totalTok = promptT + compT;
    rows.push({
      config: cfg.id,
      name: cfg.name,
      tasks: n,
      runs,
      success,
      successRate: Math.round((success / samples) * 1000) / 1000,
      pass,
      accuracy: Math.round((pass / samples) * 1000) / 1000,
      avgLatencyMs: Math.round(totalMs / samples),
      avgTokens: Math.round(totalTok / samples),
      avgPromptTokens: Math.round(promptT / samples),
      avgCompletionTokens: Math.round(compT / samples),
      estCostUsd: Math.round(((promptT / 1e6) * PRICE_IN_PER_MT + (compT / 1e6) * PRICE_OUT_PER_MT) * 1e6) / 1e6,
    });
  }

  // McNemar 検定: Baseline（OFF）vs +AVM（ON）の対応ペア（タスク × run）
  let b = 0, c = 0;
  const pairs = Math.min(baselineOutcomes.length, avmOutcomes.length);
  for (let i = 0; i < pairs; i++) {
    if (!baselineOutcomes[i] && avmOutcomes[i]) b++;
    else if (baselineOutcomes[i] && !avmOutcomes[i]) c++;
  }
  const pValue = mcnemarExactP(b, c);
  const stats: AblationStats = { mcnemarAvm: { n: b + c, b, c, pValue, significant: pValue < 0.05 } };

  return {
    kind: 'real-api',
    model,
    runs,
    rows,
    perTask,
    stats,
    note: `kind=real-api（実 API・数値は偽装しない）。同一タスク（${tasks.length} 問: 数学 ${tasks.filter((t) => t.category === 'math').length} / 知識 ${tasks.filter((t) => t.category === 'knowledge').length}）・同一モデル（${model}）・各構成 ${runs} 回実行で比較。①素のプロンプト ②AVM が明示知識から必要ページを供給 ③Executive（aiosExecute）のみ ④AVM + Executive。正答は数値一致 or キーワード包含で検証。AVM ON/OFF の差は McNemar 検定（両側正確二項検定）で評価。コストは token × 概算単価（in $0.28 / out $0.42 per 1M）。`,
  };
}

/** 表形式レンダリング */
export function renderAblationBaseline(r: AblationResult): string {
  const lines: string[] = [];
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`Ablation Baseline — ${r.model}（同一タスク ${r.rows[0]?.tasks ?? 0} 問・同一モデル・${r.runs} 回・4 構成）`);
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`${'構成'.padEnd(18)} ${'正答率'.padEnd(7)} ${'成功率'.padEnd(7)} ${'lat(ms)'.padEnd(8)} ${'tok'.padEnd(6)} ${'cost$'.padEnd(8)}`);
  for (const row of r.rows) {
    lines.push(
      `${row.name.padEnd(18)} ${(row.accuracy * 100).toFixed(0).padStart(3) + '%'.padEnd(4)} ${(row.successRate * 100).toFixed(0).padStart(3) + '%'.padEnd(4)} ${String(row.avgLatencyMs).padEnd(8)} ${String(row.avgTokens).padEnd(6)} ${row.estCostUsd.toFixed(5).padEnd(8)}`,
    );
  }
  lines.push('');
  const b = r.rows.find((x) => x.config === 'baseline')!;
  const a = r.rows.find((x) => x.config === 'avm')!;
  const f = r.rows.find((x) => x.config === 'full')!;
  lines.push(`> AVM ON/OFF: 正答率 ${(b.accuracy * 100).toFixed(0)}% → ${(a.accuracy * 100).toFixed(0)}%${a.accuracy > b.accuracy ? '（改善）' : '（変化なし/低下）'}・lat ${b.avgLatencyMs}→${a.avgLatencyMs}ms・tok ${b.avgTokens}→${a.avgTokens}`);
  const m = r.stats.mcnemarAvm;
  lines.push(`> McNemar（AVM ON/OFF・${m.n} 不一致ペア）: b=${m.b} c=${m.c} p=${m.pValue.toFixed(4)} → ${m.significant ? '統計的に有意' : '統計的に有意でない（有意水準 0.05）'}`);
  lines.push(`> Full vs Baseline: 正答率 ${(b.accuracy * 100).toFixed(0)}% → ${(f.accuracy * 100).toFixed(0)}%${f.accuracy > b.accuracy ? '（改善）' : '（変化なし/低下）'}・lat ${b.avgLatencyMs}→${f.avgLatencyMs}ms・tok ${b.avgTokens}→${f.avgTokens}`);
  lines.push('※ 同一モデル（flash）で AVM / Executive の寄与を分離。数値は実測。');
  return lines.join('\n');
}

/** レポート書き出し（reports/ablation/） */
export async function writeAblationReport(r: AblationResult, dir = 'reports/ablation'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const jsonPath = `${dir}/ablation.json`;
  const mdPath = `${dir}/ablation.md`;
  await writeFile(jsonPath, JSON.stringify(r, null, 2), 'utf8');

  const md = [
    `# Ablation Baseline — ${r.model}`,
    '',
    `- kind: real-api（実 API 呼び出し・数値は偽装しない）`,
    `- 実行日時: ${new Date().toISOString()}`,
    `- タスク: ${r.rows[0]?.tasks ?? 0} 問（数学 + 知識 QA）× ${r.runs} 回・同一モデル`,
    '',
    '## 構成別サマリ',
    '',
    '| 構成 | 正答率 | 成功率 | 平均レイテンシ | 平均トークン | コスト($) |',
    '|---|---|---|---|---|---|',
    ...r.rows.map((row) => `| ${row.name} | ${(row.accuracy * 100).toFixed(0)}% | ${(row.successRate * 100).toFixed(0)}% | ${row.avgLatencyMs}ms | ${row.avgTokens} | ${row.estCostUsd.toFixed(5)} |`),
    '',
    '## 統計検定（AVM ON/OFF・McNemar・対応のある 2 値データ）',
    '',
    `| 指標 | 値 |`,
    '|---|---|',
    `| Baseline のみ誤答・AVM のみ正答（b） | ${r.stats.mcnemarAvm.b} |`,
    `| Baseline のみ正答・AVM のみ誤答（c） | ${r.stats.mcnemarAvm.c} |`,
    `| 不一致ペア数（b+c） | ${r.stats.mcnemarAvm.n} |`,
    `| 両側正確 p 値 | ${r.stats.mcnemarAvm.pValue.toFixed(4)} |`,
    `| 判定（有意水準 0.05） | ${r.stats.mcnemarAvm.significant ? '**有意**' : '有意でない'} |`,
    '',
    '## タスク別',
    '',
    '| 構成 | タスク | 正解 | レイテンシ | トークン | 応答 |',
    '|---|---|---|---|---|---|',
    ...r.perTask.map((p) => {
      const mark = r.runs > 1 ? `${p.verified}/${p.runs}` : (p.verified > 0 ? '✅' : '❌');
      return `| ${p.config} | ${p.taskId} | ${mark} | ${p.ms}ms | ${p.promptTokens + p.completionTokens} | ${p.text.replace(/\r?\n/g, ' ').replace(/\|/g, '｜').slice(0, 50)}${p.error ? `（${p.error}）` : ''} |`;
    }),
    '',
    '## 解釈（データから導出・バイアス除去した見解）',
    '',
    ...(interpret(r).map((l) => `- ${l}`)),
    '',
    `> note: ${r.note}`,
    '',
  ].join('\n');
  await writeFile(mdPath, md, 'utf8');
  return jsonPath;
}

/**
 * 4 構成の差から導出する解釈。数値は実測のみに基づき、
 * 小サンプル（12 問）のため差は誤差範囲の可能性があることを併記する。
 */
function interpret(r: AblationResult): string[] {
  const by = (c: string) => r.rows.find((x) => x.config === c)!;
  const b = by('baseline'), a = by('avm'), e = by('executive'), f = by('full');
  const acc = (x: number) => (x * 100).toFixed(0) + '%';
  const out: string[] = [];
  // 成功率は各構成の実測値を使う（4 構成すべて同値のときだけ共通文にする）
  const rates = [b, a, e, f].map((x) => x.successRate);
  if (rates.every((v) => v === rates[0])) {
    out.push(`成功率は 4 構成とも ${acc(b.successRate)}。`);
  } else {
    out.push(`成功率は構成ごとに異なる: Baseline ${acc(b.successRate)} / +AVM ${acc(a.successRate)} / +Executive ${acc(e.successRate)} / Full ${acc(f.successRate)}。`);
  }
  if (a.accuracy > b.accuracy) {
    out.push(`AVM（明示知識の検索・供給）は正答率を ${acc(b.accuracy)} → ${acc(a.accuracy)} に改善。知識タスクで文脈供給が有効に働いたことを示す。`);
  } else {
    out.push(`AVM は正答率に明確な改善なし（${acc(b.accuracy)} → ${acc(a.accuracy)}）。`);
  }
  // ② Executive の寄与（Baseline → +Executive）
  const eLat = e.avgLatencyMs - b.avgLatencyMs;
  if (e.accuracy > b.accuracy) {
    out.push(`Executive は正答率を ${acc(b.accuracy)} → ${acc(e.accuracy)} に改善（レイテンシ差 ${eLat > 0 ? '+' : ''}${eLat}ms）。`);
  } else {
    out.push(`Executive 単独では正答率に改善なし（${acc(b.accuracy)} → ${acc(e.accuracy)}）。レイテンシは ${eLat > 0 ? '+' : ''}${eLat}ms（${eLat > 0 ? 'オーバーヘッド' : 'むしろ低減'}）。`);
  }
  // ③ Full と AVM 単独の比較（Executive の prompt 再構築が AVM の利点を相殺しないか）
  if (f.accuracy < a.accuracy) {
    out.push(`Full（AVM + Executive）は AVM 単独の ${acc(a.accuracy)} を下回る ${acc(f.accuracy)}。Executive のプロンプト再構築が AVM の供給文脈を一部相殺する可能性がある（要検証）。`);
  } else {
    out.push(`Full は AVM 単独（${acc(a.accuracy)}）と同等以上の ${acc(f.accuracy)}。`);
  }
  // 統計検定の結果（AVM ON/OFF）
  const m = r.stats.mcnemarAvm;
  if (m.n === 0) {
    out.push(`AVM ON/OFF の不一致ペアは 0（両構成とも全タスク同結果）。`);
  } else if (m.significant) {
    out.push(`AVM ON/OFF の差は統計的に有意（McNemar 両側正確検定: b=${m.b} c=${m.c} p=${m.pValue.toFixed(4)} < 0.05）。${m.b > m.c ? 'AVM が優位' : 'Baseline が優位'}。`);
  } else {
    out.push(`AVM ON/OFF の差は統計的に有意ではない（McNemar 両側正確検定: b=${m.b} c=${m.c} p=${m.pValue.toFixed(4)} ≧ 0.05）。`);
  }
  out.push(`※ ${r.rows[0]?.tasks ?? 0} 問 × ${r.runs} 回のサンプル。構成間の差は${Math.round((100 / ((r.rows[0]?.tasks ?? 1) * (r.runs ?? 1))) * 100) / 100}%（1 サンプル = タスク × 回）単位の変動を含み得る。タスクを増やした再計測（Phase 4 継続）で有意性を詰める。`);
  return out;
}
