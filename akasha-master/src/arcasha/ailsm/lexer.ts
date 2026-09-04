/**
 * AILSM Lexer — 自然言語のトークン化（100% 決定論）
 *
 * 数値 / 変数 / 数式 / 単語 に分割する。数式（演算子を含むASCII連続）は
 * 単一トークンとして保持し、後段の Normalizer へ渡す。
 */

export type TokenType = 'number' | 'variable' | 'math' | 'word';

export interface Token {
  type: TokenType;
  value: string;
}

const ASCII_RUN_RE = /^[0-9a-zA-Z^+\-*/=().]+/;
const JAPANESE_RUN_RE = /^[\u3040-\u30ff\u3400-\u9fff]+/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const rest = text.slice(i);

    // ASCII 連続を優先（数式 '2+3' を分割しない。演算子を含むかで分類）
    const ascii = ASCII_RUN_RE.exec(rest);
    if (ascii) {
      const s = ascii[0];
      if (/[+\-*/=^]/.test(s)) {
        // ファイルパス（スラッシュ区切り + 英字拡張子、例: src/arcasha/tools.ts）は数式ではない。
        // ただし小数除算（2/3.14, x/2.0）を誤ってパス扱いしないよう、
        // 「スラッシュの左にディレクトリ名（英字）があり、拡張子が英字で始まる」場合だけをパスとみなす。
        // 例: src/main.ts → パス（左=src 英字, 拡張子 .ts 英字）
        //     2/3.14    → math（左=2 数字, 拡張子 .14 数字）
        //     x/2.0     → math（拡張子 .0 数字）
        const pathLike = /.*[A-Za-z_]\/[^/]*\.[A-Za-z][A-Za-z0-9]*$/.test(s);
        if (pathLike) {
          tokens.push({ type: 'word', value: s });
        } else {
          tokens.push({ type: 'math', value: s });
        }
      } else if (/^\d+(?:\.\d+)?$/.test(s)) {
        tokens.push({ type: 'number', value: s });
      } else if (/^[a-zA-Z]$/.test(s)) {
        tokens.push({ type: 'variable', value: s });
      } else {
        tokens.push({ type: 'word', value: s });
      }
      i += s.length;
      continue;
    }

    const jp = JAPANESE_RUN_RE.exec(rest);
    if (jp) {
      tokens.push({ type: 'word', value: jp[0] });
      i += jp[0].length;
      continue;
    }

    i++; // 句読点・空白は読み飛ばす
  }
  return tokens;
}
