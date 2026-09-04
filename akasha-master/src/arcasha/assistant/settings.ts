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

export interface AssistantSettings {
  /** DeepSeek API キー（空 = .env の DEEPSEEK_API_KEY を使う） */
  apiKey: string;
  /** API ベース URL（空 = 既定 https://api.deepseek.com） */
  apiBase: string;
  /** 既定モデル（モデル選択の初期値） */
  model: string;
  /** 「その他」で入力したカスタムモデル名（推論ロールに使う。空 = 既定 Pro） */
  customModel: string;
  /** オーケストレーションに参加できるモデル数（1〜50、既定 2） */
  orchestrationCount: number;
  /** ハイパー Thinking モード（thinking enabled + reasoning_effort=max） */
  hyperThinking: boolean;
  /** UI 言語 */
  language: UiLanguage;
}

export const ORCHESTRATION_MIN = 1;
export const ORCHESTRATION_MAX = 50;

export function defaultSettings(): AssistantSettings {
  return {
    apiKey: '',
    apiBase: '',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    customModel: '',
    orchestrationCount: 2,
    hyperThinking: false,
    language: 'ja',
  };
}

function settingsPath(): string {
  return path.join(defaultMemoryDir(), 'assistant-settings.json');
}

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.max(ORCHESTRATION_MIN, Math.min(ORCHESTRATION_MAX, Math.round(n)));
}

function sanitize(s: unknown): string {
  return String(s ?? '').trim();
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
    if (typeof patch.apiKey === 'string') s.apiKey = patch.apiKey;
    if (typeof patch.apiBase === 'string') s.apiBase = sanitize(patch.apiBase);
    if (typeof patch.model === 'string' && sanitize(patch.model)) s.model = sanitize(patch.model);
    if (typeof patch.customModel === 'string') s.customModel = sanitize(patch.customModel);
    if (patch.orchestrationCount !== undefined) s.orchestrationCount = clampCount(patch.orchestrationCount);
    if (typeof patch.hyperThinking === 'boolean') s.hyperThinking = patch.hyperThinking;
    if (patch.language !== undefined) s.language = sanitizeLanguage(patch.language);
    this.scheduleWrite();
    return this.settings;
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
