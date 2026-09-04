/**
 * モデル艦隊（Model Fleet）— 複数モデルをタスク分類でルーティングする共通基盤
 *
 * チャットサーバーと Intelligence Runtime（plugin）の両方が使う「タスク → モデル」
 * の対応を一元化する。Flash = 汎用/高速、Pro = 推論/数学/コード。
 *
 * プラグイン方針: Future Orchestrator が「どこで実行するか」を決める際に、
 * この艦隊定義（どのモデルが何を得意とするか）を能力として公開できる。
 */
import { ExpertHub } from '../experts/registry.js';

/** タスクの種類（どのモデル・エキスパートに任せるか） */
export type TaskKind = 'math' | 'code' | 'reasoning' | 'search' | 'general';

export interface FleetExpert {
  nodeId: string;
  model: string;
  role: 'general' | 'reasoning';
  label: string;
  /** このノードがどの API プロバイダ（設定の providers）で呼ぶか。無ければ既定。 */
  providerId?: string;
}

/** 発言からタスク種別を推定する（簡易キーワード分類・英語キーワードは単語境界） */
export function classifyTask(text: string): TaskKind {
  if (/[=∫∑√π∞]|\d+\s*[+\-*/^]\s*\d+|数学|算数|積分|微分|方程式|計算|因数分解|確率|幾何|行列|対数|三角関数|数式|数列|図形/i.test(text)) return 'math';
  if (/コード|プログラム|実装|バグ|関数|クラス|型|アルゴリズム|リファクタ|\b(typescript|python|javascript|rust|react|api)\b/i.test(text)) return 'code';
  if (/なぜ|理由|説明|考察|証明|戦略|計画|設計|比較|分析|仮説|どう思う/i.test(text)) return 'reasoning';
  if (/検索|調べて|とは|意味|定義|まとめ|要約|一覧/i.test(text)) return 'search';
  return 'general';
}

/** タスク種別 → 担当エキスパート（math/code/reasoning は Pro、search/general は Flash） */
export function routeExpert(kind: TaskKind, fleet: FleetExpert[]): FleetExpert {
  if (fleet.length === 0) throw new Error('routeExpert: 艦隊（fleet）が空です');
  if (kind === 'math' || kind === 'code' || kind === 'reasoning') {
    return fleet.find((e) => e.role === 'reasoning') ?? fleet[0];
  }
  return fleet.find((e) => e.role === 'general') ?? fleet[0];
}

export interface BuildFleetOptions {
  /** 接続ログを出す（既定 false） */
  verbose?: boolean;
  /** true のとき API キーを無視してモックのみ（selftest 用） */
  forceMock?: boolean;
}

/**
 * エキスパート艦隊を構築して Hub に登録する。
 * DeepSeek API キーがあれば Flash/Pro を登録、無ければモック 2 台。
 * 返る艦隊は常に空でない（routeExpert / ルーティングがクラッシュしない）。
 */
export function buildFleet(hub: ExpertHub, opts: BuildFleetOptions = {}): FleetExpert[] {
  const key = opts.forceMock ? '' : process.env.DEEPSEEK_API_KEY ?? '';
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const base = (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const fleet: FleetExpert[] = [];

  if (key) {
    fleet.push({ nodeId: 'expert-flash', model, role: 'general', label: 'Flash（汎用）' });
    fleet.push({ nodeId: 'expert-pro', model: process.env.DEEPSEEK_PRO_MODEL ?? 'deepseek-v4-pro', role: 'reasoning', label: 'Pro（推論）' });
    for (const e of fleet) {
      hub.addApiNode(e.nodeId, base, key, e.model);
      if (opts.verbose) console.log(`  ☁️ 実モデル接続: ${e.nodeId} (${e.model} @ ${base}) [${e.role}]`);
    }
  } else {
    if (opts.verbose) console.log('  ⚠️ DEEPSEEK_API_KEY が無いためモックノードで動作します（実タスクには .env を設定）');
    hub.addMockNode('mock-a', 'HuggingFaceTB/SmolLM2-135M-Instruct');
    hub.addMockNode('mock-b', 'HuggingFaceTB/SmolLM2-135M-Instruct');
    fleet.push({ nodeId: 'mock-a', model: 'mock', role: 'general', label: 'Mock（汎用）' });
    fleet.push({ nodeId: 'mock-b', model: 'mock', role: 'reasoning', label: 'Mock（推論）' });
  }
  return fleet;
}
