/**
 * ArcAsha Assistant — ユーザー発言からの「記憶」抽出ルール
 *
 * 自己紹介・好み・苦手などを自然文からルール抽出する。
 * モデルに頼らず決定的なので、テスト可能で誤抽出が起きにくい。
 */

export interface RememberedItem {
  text: string;
  category: 'user' | 'preference';
}

/** 名前らしい文字列か（助詞・動詞を除外して名前だけを取り出す） */
export function cleanName(raw: string): string {
  return raw.replace(/[です。、ますだってください呼んでいい]/g, '').trim();
}

/** 既存 memory に重複があるか（重複保存を防ぐ） */
export type DupChecker = (key: string) => boolean;

/**
 * ユーザー発言から「覚えるべき事柄」をルール抽出する（複数対応）。
 * @param query ユーザー発言
 * @param isDuplicate 重複チェッカー（既に記憶済みのキーなら true を返す）
 */
export function extractRememberAll(query: string, isDuplicate: DupChecker): RememberedItem[] {
  const out: RememberedItem[] = [];
  const add = (text: string, category: RememberedItem['category'], key: string): void => {
    if (!text) return;
    if (!isDuplicate(key)) out.push({ text, category });
  };

  // 名前: 「私の名前は太郎」「太郎と呼んで」「私は花子と呼んでください」
  const namePatterns = [
    /(?:私|僕|俺|わたし)(?:の)?名前(?:は|が)\s*([ぁ-んァ-ヶー一-龠々a-zA-Z0-9・]+)/,
    /私は\s*([ぁ-んァ-ヶー一-龠々a-zA-Z0-9・]+?)\s*と\s*(?:呼んで|言って|お呼び)/,
    /([ぁ-んァ-ヶー一-龠々a-zA-Z0-9・]{1,12})\s*と\s*(?:呼んで|言って|お呼び)/,
  ];
  for (const re of namePatterns) {
    const m = query.match(re);
    if (!m) continue;
    const name = cleanName(m[1]);
    if (name && !/^(私|僕|俺|わたし|あなた)$/.test(name)) {
      add(`ユーザーの名前は${name}さん`, 'user', name);
    }
    break;
  }

  // 好み（1 文中に複数ある場合に備えて全マッチ走査）: 「ラーメンが好き」「猫は苦手」
  // 文の区切り（。！？や改行）の直後から始まるようにして前文の末尾を取り込まない
  const prefRe = /(?:^|[。！？!?\n])([ぁ-んァ-ヶー一-龠々a-zA-Z0-9・]{1,12}?)\s*(?:が|は)\s*(好き|嫌い|大好き|苦手)/g;
  let pm: RegExpExecArray | null;
  while ((pm = prefRe.exec(query)) !== null) {
    const pref = pm[1].trim();
    if (pref && !/^(私|僕|俺|わたし|あなた|それ|これ|あれ)$/.test(pref)) {
      add(`ユーザーは${pref}が${pm[2]}`, 'preference', pref);
    }
  }
  return out;
}
