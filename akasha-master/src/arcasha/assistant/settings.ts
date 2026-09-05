/**
 * ArcAsha Assistant — 設定ストア（Assistant Settings）
 *
 * WebUI の「設定」タブから変更できる実行時設定を永続化する。
 * - API キー / API ベース URL（.env の代わりに Web から設定できる）
 * - 使用モデル（既存モデル or「その他」で自由入力したカスタムモデル）
 * - オーケストレーション参加モデル数（1〜50）
 * - ハイパー Thinking モード（thinking + reasoning_effort=max）
 * - UI 言語（ja / en / zh / ko）
 *
 * 保存先: 既定 ~/.arcasha/assistant-settings.json（env ARCASHA_MEMORY_DIR に追従）。
 * リポジトリ外のユーザーディレクトリに保存するため、API キーが git に入ることはない。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultMemoryDir } from './long-term-memory.js';

export type UiLanguage = 'ja' | 'en' | 'zh' | 'ko';

/** フリート（オーケストレーション）の構成モード。 */
export type FleetMode = 'roles' | 'uniform' | 'custom';

/** 1 つの API プロバイダ（モデルごとに baseUrl / apiKey / model を紐付けて登録）。 */
export interface ApiProvider {
  /** 一意な ID（例: 'deepseek', 'openai', 'custom-2'）。 */
  id: string;
  /** 表示名（例: 'DeepSeek', 'OpenAI'）。 */
  name: string;
  /** API キー（空なら env の DEEPSEEK_API_KEY をフォールバック）。 */
  apiKey: string;
  /** API ベース URL（例: https://api.deepseek.com）。 */
  apiBase: string;
  /** このプロバイダが公開するモデル名。 */
  model: string;
}

/**
 * カスタムフリートの 1 ノード（fleetMode='custom' のとき使用）。
 * role は自由な役割名（'general' / 'reasoning' に加え、'code' / 'review' / 'creative' 等も可）。
 * expertise はこのノードが得意とするタスク種別（math/code/reasoning/search/general）。指定すると
 * その種別のタスクが優先的にこのノードへ振り分けられる。無指定なら role の general/reasoning で従来ルーティング。
 */
export interface CustomFleetNode {
  /** 一意な ID（例: 'n1', 'review-1'）。 */
  id: string;
  /** 表示名（例: 'コードレビュー', '数学エキスパート'）。 */
  label: string;
  /** 役割名（'general' / 'reasoning' / 自由名）。 */
  role: string;
  /** このノードが使用するモデル名（例: 'deepseek-v4-flash'）。 */
  model: string;
  /** このノードが呼ぶ API プロバイダ ID（省略 = モデル名一致のプロバイダ / 既定）。 */
  providerId?: string;
  /** 得意なタスク種別（任意）。指定するとその種別のタスクが優先的に振り分けられる。 */
  expertise?: 'math' | 'code' | 'reasoning' | 'search' | 'general';
}

export interface AssistantSettings {
  /** DeepSeek API キー（空 = .env の DEEPSEEK_API_KEY を使う）。既定プロバイダ #0 と同期。 */
  apiKey: string;
  /** API ベース URL（空 = 既定 https://api.deepseek.com）。既定プロバイダ #0 と同期。 */
  apiBase: string;
  /** 既定モデル（モデル選択の初期値） */
  model: string;
  /** 「その他」で入力したカスタムモデル名（推論ロールに使う。空 = 既定 Pro） */
  customModel: string;
  /** オーケストレーションに参加できるモデル数（1〜50、既定 2） */
  orchestrationCount: number;
  /** フリート構成モード: 'roles' = General/Reasoning 役割別 / 'uniform' = 選んだモデルで N 台 / 'custom' = 手動ノード構成 */
  fleetMode: FleetMode;
  /** fleetMode='custom' のとき使う手動ノード構成。既存の roles/uniform では使われない。 */
  customNodes: CustomFleetNode[];
  /** Coding Agent（実ファイル編集）の作業ワークスペース（開発ディレクトリ）。空 = env/cwd。 */
  workdir: string;
  /** 複数 API プロバイダの登録リスト（先頭 = 既定）。空なら旧 apiKey/apiBase から構築。 */
  providers: ApiProvider[];
  /** ハイパー Thinking / thinking モード時に思考（reasoning）へ割り当てるトークン上限（既定 8000） */
  thinkingTokens: number;
  /** ハイパー Thinking モード（thinking enabled + reasoning_effort=max） */
  hyperThinking: boolean;
  /** UI 言語 */
  language: UiLanguage;
}

export const ORCHESTRATION_MIN = 1;
export const ORCHESTRATION_MAX = 50;
export const THINKING_TOKENS_MIN = 512;
export const THINKING_TOKENS_MAX = 32768;

function defaultProviders(): ApiProvider[] {
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const base = (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  return [{
    id: 'deepseek',
    name: 'DeepSeek',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    apiBase: base,
    model,
  }];
}

export function defaultSettings(): AssistantSettings {
  return {
    apiKey: '',
    apiBase: '',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    customModel: '',
    orchestrationCount: 2,
    fleetMode: 'roles',
    customNodes: [],
    workdir: '',
    providers: defaultProviders(),
    thinkingTokens: 8000,
    hyperThinking: false,
    language: 'ja',
  };
}

/** カスタムノード配列の正規化（不正エントリを除去）。 */
function sanitizeCustomNodes(raw: unknown): CustomFleetNode[] {
  if (!Array.isArray(raw)) return [];
  const list: CustomFleetNode[] = [];
  const seen = new Set<string>();
  const validExpertise = new Set(['math', 'code', 'reasoning', 'search', 'general']);
  for (const n of raw) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    // 明示 ID が既存と衝突する場合は捨てず、接尾辞を付けて一意化する
    let id = String(o.id ?? '').trim();
    if (!id) {
      // 既定 ID は既存と衝突しない値になるまで増やす（node-1, node-2, …）
      let k = 1;
      while (seen.has(`node-${k}`)) k++;
      id = `node-${k}`;
    } else if (seen.has(id)) {
      let k = 2;
      while (seen.has(`${id}-${k}`)) k++;
      id = `${id}-${k}`;
    }
    seen.add(id);
    const model = String(o.model ?? '').trim();
    if (!model) continue; // モデル未指定のノードはスキップ
    const expertiseRaw = String(o.expertise ?? '');
    list.push({
      id,
      label: String(o.label ?? '').trim() || id,
      role: String(o.role ?? '').trim() || 'general',
      model,
      providerId: String(o.providerId ?? '').trim() || undefined,
      expertise: validExpertise.has(expertiseRaw) ? (expertiseRaw as CustomFleetNode['expertise']) : undefined,
    });
  }
  return list;
}

/** プロバイダ配列の正規化（不正なエントリを除去し、apiKey/apiBase の空欄を既定で補完）。 */
function sanitizeProviders(raw: unknown, fallback: ApiProvider[]): ApiProvider[] {
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const list: ApiProvider[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const id = String(o.id ?? '').trim() || `provider-${list.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const model = String(o.model ?? '').trim();
    list.push({
      id,
      name: String(o.name ?? '').trim() || id,
      apiKey: String(o.apiKey ?? '').trim(),
      apiBase: String(o.apiBase ?? '').trim().replace(/\/+$/, '') || (fallback[0]?.apiBase ?? ''),
      model,
    });
  }
  return list.length > 0 ? list : fallback;
}

function sanitizeFleetMode(s: unknown): FleetMode {
  const v = String(s ?? '');
  if (v === 'uniform') return 'uniform';
  if (v === 'custom') return 'custom';
  return 'roles';
}

function settingsPath(): string {
  return path.join(defaultMemoryDir(), 'assistant-settings.json');
}

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.max(ORCHESTRATION_MIN, Math.min(ORCHESTRATION_MAX, Math.round(n)));
}

function clampThinkingTokens(n: number): number {
  if (!Number.isFinite(n)) return 8000;
  return Math.max(THINKING_TOKENS_MIN, Math.min(THINKING_TOKENS_MAX, Math.round(n)));
}

function sanitize(s: unknown): string {
  return String(s ?? '').trim();
}

/**
 * workdir は絶対パスだけ受け付ける（相対パスは cwd 依存で意図しないディレクトリを
 * 編集する恐れがあるため、空文字へ落として env / cwd の既定へ戻す）。
 * load() と update() の両方で使う（load 側も同じ guard を適用して整合させる）。
 */
function sanitizeWorkdir(v: unknown): string {
  const w = sanitize(v);
  return w === '' || path.isAbsolute(w) ? w : '';
}

function sanitizeLanguage(s: unknown): UiLanguage {
  const v = String(s ?? '').toLowerCase();
  return v === 'en' || v === 'zh' || v === 'ko' ? v : 'ja';
}

/**
 * 設定ストア。load 後に read / update する。
 */
export class SettingsStore {
  private settings: AssistantSettings = defaultSettings();
  private readonly filePath = settingsPath();
  private writeChain: Promise<void> = Promise.resolve();
  /** 書き込み世代（更新のたびに増える。古い世代の書き込みはスキップされる） */
  private writeGen = 0;

  /** 起動時に読み込む。ENOENT は既定値。JSON 破損時は .bak へ退避してから既定値で開始する。 */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`⚠️ 設定ファイルを読めません（ファイルは保持します）: ${String(e).slice(0, 160)}`);
      }
      this.settings = defaultSettings();
      return;
    }
    try {
      const data = JSON.parse(raw) as Partial<AssistantSettings>;
      const d = defaultSettings();
      this.settings = {
        apiKey: typeof data.apiKey === 'string' ? data.apiKey : d.apiKey,
        apiBase: sanitize(data.apiBase) || d.apiBase,
        model: sanitize(data.model) || d.model,
        customModel: sanitize(data.customModel),
        orchestrationCount: clampCount(data.orchestrationCount ?? d.orchestrationCount),
        fleetMode: sanitizeFleetMode(data.fleetMode),
        customNodes: sanitizeCustomNodes(data.customNodes),
        workdir: sanitizeWorkdir(data.workdir),
        providers: sanitizeProviders(data.providers, d.providers),
        thinkingTokens: clampThinkingTokens(data.thinkingTokens ?? d.thinkingTokens),
        hyperThinking: data.hyperThinking === true,
        language: sanitizeLanguage(data.language),
      };
    } catch (e) {
      // 壊れた設定ファイルで上書きしないよう .bak へ退避してから既定値で開始
      console.error(`⚠️ 設定ファイルが壊れているため .bak へ退避して既定値で開始します: ${String(e).slice(0, 160)}`);
      try {
        await fs.rename(this.filePath, `${this.filePath}.bak`);
      } catch {
        /* 退避失敗はログのみ */
      }
      this.settings = defaultSettings();
    }
  }

  get(): Readonly<AssistantSettings> {
    return this.settings;
  }

  /** 部分更新して永続化（JSON 直列化で多重書き込みを防ぐ） */
  update(patch: Partial<AssistantSettings>): Readonly<AssistantSettings> {
    const s = this.settings;
    // 旧フィールド（apiKey / apiBase）と providers[0] を双方向で同期する（後方互換）。
    // UI は providers 経由で保存するため、どちらが来ても整合する。
    if (Array.isArray(patch.providers)) {
      s.providers = sanitizeProviders(patch.providers, s.providers);
      const p0 = s.providers[0];
      if (p0) {
        s.apiKey = p0.apiKey;
        if (p0.apiBase) s.apiBase = p0.apiBase;
      }
    }
    if (typeof patch.apiKey === 'string') {
      s.apiKey = patch.apiKey;
      if (s.providers.length > 0 && patch.apiKey !== '') s.providers[0].apiKey = patch.apiKey;
    }
    if (typeof patch.apiBase === 'string') {
      const base = sanitize(patch.apiBase);
      s.apiBase = base;
      if (s.providers.length > 0 && base !== '') s.providers[0].apiBase = base;
    }
    if (typeof patch.model === 'string' && sanitize(patch.model)) s.model = sanitize(patch.model);
    if (typeof patch.customModel === 'string') s.customModel = sanitize(patch.customModel);
    if (patch.orchestrationCount !== undefined) s.orchestrationCount = clampCount(patch.orchestrationCount);
    if (patch.fleetMode !== undefined) s.fleetMode = sanitizeFleetMode(patch.fleetMode);
    if (patch.customNodes !== undefined) s.customNodes = sanitizeCustomNodes(patch.customNodes);
    // workdir は絶対パスだけ受け付ける（sanitizeWorkdir で load / update を整合）
    if (typeof patch.workdir === 'string') s.workdir = sanitizeWorkdir(patch.workdir);
    if (patch.thinkingTokens !== undefined) s.thinkingTokens = clampThinkingTokens(patch.thinkingTokens);
    if (typeof patch.hyperThinking === 'boolean') s.hyperThinking = patch.hyperThinking;
    if (patch.language !== undefined) s.language = sanitizeLanguage(patch.language);
    this.scheduleWrite();
    return this.settings;
  }

  /** 既定プロバイダ（providers[0]）。無ければ構築。 */
  defaultProvider(): ApiProvider {
    if (this.settings.providers.length > 0) return this.settings.providers[0];
    const d = defaultProviders();
    this.settings.providers = d;
    return d[0];
  }

  /** ID でプロバイダを探す（無ければ undefined）。 */
  providerById(id: string): ApiProvider | undefined {
    return this.settings.providers.find((p) => p.id === id);
  }

  /** 設定ファイルのパス（UI 表示用） */
  path(): string {
    return this.filePath;
  }

  /**
   * 世代番号で書き込みを管理する。
   * 書き込み中に新しい update が来た場合はこの書き込みをスキップし、
   * 後続のチェーン（最新世代）が最新状態を保存する。
   */
  private scheduleWrite(): void {
    const gen = ++this.writeGen;
    this.writeChain = this.writeChain.then(async () => {
      if (gen !== this.writeGen) return; // より新しい更新が来ている → そちらに任せる
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + '.tmp';
        // API キーを含むため 0600 で作成（他のローカルユーザーから読めないように）
        await fs.writeFile(tmp, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(tmp, 0o600); // 失敗したら rename せず throw（0600 以外で保存しない）
        await fs.rename(tmp, this.filePath);
      } catch (e) {
        console.error(`⚠️ 設定の保存に失敗（次回の update 時に再試行します）: ${String(e).slice(0, 120)}`);
      }
    });
  }
}

/** API キーをマスク表示する（sk-5201...abcd） */
export function maskSecret(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
