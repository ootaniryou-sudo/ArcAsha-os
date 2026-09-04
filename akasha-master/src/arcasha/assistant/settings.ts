/**
 * ArcAsha Assistant — 設定ストア（Assistant Settings）
 *
 * WebUI の「設定」タブから変更できる実行時設定を永続化する。
 * - API キー / API ベース URL（.env の代わりに Web から設定できる）
 * - 使用モデル（既存モデル or「その他」で自由入力したカスタムモデル）
 * - オーケストレーション参加モデル数（1〜4）
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
  /** オーケストレーションに参加できるモデル数（1〜4、既定 2） */
  orchestrationCount: number;
  /** ハイパー Thinking モード（thinking enabled + reasoning_effort=max） */
  hyperThinking: boolean;
  /** UI 言語 */
  language: UiLanguage;
}

export const ORCHESTRATION_MIN = 1;
export const ORCHESTRATION_MAX = 4;

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
  private dirty = false;

  /** 起動時に読み込む（無ければ既定値で開始） */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
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
    } catch {
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

  private scheduleWrite(): void {
    this.dirty = true;
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8');
        await fs.rename(tmp, this.filePath);
      } catch (e) {
        console.error(`⚠️ 設定の保存に失敗: ${String(e).slice(0, 120)}`);
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
