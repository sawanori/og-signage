/**
 * メンバー紹介の一覧（spotlights-view.tsx）の あ行・か行… の絞り込み・名前順・検索（2026-09-27 ユーザー指示）。
 * 漢字の名前は読みが分からないので、ふりがな（任意）で決める。ふりがなが無ければ、お名前がかなで始まるときだけ
 * お名前を読みとして使い、それ以外の人は「その他」にまとめる。
 */

/** 絞り込みに出す順 */
export const KANA_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "その他"] as const;
export type KanaRow = (typeof KANA_ROWS)[number];

/** 行ごとのかな（ひらがな）。濁音・半濁音・小さい字は元の行に入れる（ざ→さ行、ぱ→は行、ゃ→や行、ゔ→あ行） */
const ROW_CHARS: [KanaRow, string][] = [
  ["あ", "ぁあぃいぅうぇえぉおゔ"],
  ["か", "かがきぎくぐけげこごゕゖ"],
  ["さ", "さざしじすずせぜそぞ"],
  ["た", "ただちぢっつづてでとど"],
  ["な", "なにぬねの"],
  ["は", "はばぱひびぴふぶぷへべぺほぼぽ"],
  ["ま", "まみむめも"],
  ["や", "ゃやゅゆょよ"],
  ["ら", "らりるれろ"],
  ["わ", "ゎわゐゑをん"],
];

type Named = { personName: string; personNameKana: string | null };

/** 全角・半角をそろえ（NFKC。半角カナも全角になる）、カタカナをひらがなにする */
export function toHiragana(text: string): string {
  return text.normalize("NFKC").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 検索で 全角・半角、大文字・小文字、カタカナ・ひらがな の違いを無視するため、両側をこの形にそろえて比べる */
export function normalizeForSearch(text: string): string {
  return toHiragana(text).toLowerCase();
}

function rowOfChar(char: string | undefined): KanaRow | null {
  const hit = char ? ROW_CHARS.find(([, chars]) => chars.includes(char)) : undefined;
  return hit ? hit[0] : null;
}

/** 行分けと名前順に使う読み（ひらがな）。ふりがなが無く、お名前もかなで始まらなければ null */
export function readingOf({ personName, personNameKana }: Named): string | null {
  if (personNameKana) return toHiragana(personNameKana);
  const name = toHiragana(personName);
  return rowOfChar(name[0]) ? name : null;
}

/** 読みの 1 文字目で決めた行。読みが無いか、かなで始まらなければ「その他」 */
export function kanaRowOf(person: Named): KanaRow {
  return rowOfChar(readingOf(person)?.[0]) ?? "その他";
}

const collator = new Intl.Collator("ja");

/**
 * 名前順（あいうえお）。読みのひらがなで比べ、「その他」の人は後ろにまとめてお名前で並べる。
 * 同じ読みの人は元の並び（登録順）のまま
 */
export function sortByReading<T extends Named>(people: readonly T[]): T[] {
  return people
    .map((person) => ({
      person,
      other: kanaRowOf(person) === "その他",
      key: readingOf(person) ?? toHiragana(person.personName),
    }))
    .sort((a, b) => Number(a.other) - Number(b.other) || collator.compare(a.key, b.key))
    .map(({ person }) => person);
}
