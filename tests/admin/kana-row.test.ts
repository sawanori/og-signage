/**
 * メンバー紹介の一覧の あ行・か行… の絞り込み・名前順・検索で使う かな の扱い（components/admin/kana-row.ts。2026-09-27 ユーザー指示）。
 */
import { describe, expect, it } from "vitest";
import { KANA_ROWS, kanaRowOf, normalizeForSearch, readingOf, sortByReading, toHiragana } from "@/components/admin/kana-row";

const person = (personName: string, personNameKana: string | null = null) => ({ personName, personNameKana });

describe("toHiragana", () => {
  it("カタカナ（半角も）をひらがなにする。漢字・記号はそのままで、全角の英数字と空白は半角になる", () => {
    expect(toHiragana("サワダ ノリタカ")).toBe("さわだ のりたか");
    expect(toHiragana("ｻﾜﾀﾞ ﾉﾘﾀｶ")).toBe("さわだ のりたか");
    expect(toHiragana("ヴァヵヶ")).toBe("ゔぁゕゖ");
    expect(toHiragana("山田 タロウ・ー")).toBe("山田 たろう・ー");
    expect(toHiragana("ＮｏｎＴｕｒｎ　１")).toBe("NonTurn 1");
  });
});

describe("normalizeForSearch", () => {
  it("大文字・小文字、全角・半角、カタカナ・ひらがな の違いをなくす", () => {
    expect(normalizeForSearch("ＷＥＢ デザイン")).toBe("web でざいん");
    expect(normalizeForSearch("ｻﾝﾌﾟﾙ")).toBe(normalizeForSearch("さんぷる"));
  });
});

describe("kanaRowOf", () => {
  it("ふりがなの 1 文字目の行。カタカナ・半角カナのふりがなも同じ行になる", () => {
    for (const row of KANA_ROWS.filter((r) => r !== "その他")) expect(kanaRowOf(person("名前", row))).toBe(row);
    expect(kanaRowOf(person("山田 太郎", "やまだ たろう"))).toBe("や");
    expect(kanaRowOf(person("沢田 紀孝", "サワダ ノリタカ"))).toBe("さ");
    expect(kanaRowOf(person("沢田 紀孝", "ｻﾜﾀﾞ"))).toBe("さ");
  });

  it("濁音・半濁音・小さい字は元の行（ざ→さ行、ぱ→は行、ゃ→や行、ゔ→あ行）。を・ん は わ行", () => {
    const cases: [string, string][] = [
      ["ざいつ", "さ"],
      ["ぱく", "は"],
      ["バンバ", "は"],
      ["がとう", "か"],
      ["ヶ", "か"],
      ["ぢ", "た"],
      ["っ", "た"],
      ["ゃ", "や"],
      ["ョ", "や"],
      ["ぁ", "あ"],
      ["ゔぃ", "あ"],
      ["ヴィクトール", "あ"],
      ["ゎ", "わ"],
      ["を", "わ"],
      ["ん", "わ"],
    ];
    for (const [kana, row] of cases) expect(kanaRowOf(person("名前", kana)), kana).toBe(row);
  });

  it("ふりがなが無ければ、かなで始まるお名前で決める。漢字や英字の名前は「その他」", () => {
    expect(kanaRowOf(person("さくら"))).toBe("さ");
    expect(kanaRowOf(person("アレックス"))).toBe("あ");
    expect(kanaRowOf(person("山田 太郎"))).toBe("その他");
    expect(kanaRowOf(person("Alex"))).toBe("その他");
  });

  it("ふりがながかなで始まらなければ「その他」", () => {
    expect(kanaRowOf(person("山田 太郎", "ーやまだ"))).toBe("その他");
  });
});

describe("readingOf", () => {
  it("ふりがな（ひらがなにそろえる）、無ければかなのお名前。どちらも無ければ null", () => {
    expect(readingOf(person("山田 太郎", "ヤマダ タロウ"))).toBe("やまだ たろう");
    expect(readingOf(person("サクラ"))).toBe("さくら");
    expect(readingOf(person("山田 太郎"))).toBeNull();
  });
});

describe("sortByReading", () => {
  it("読みのあいうえお順（カタカナのふりがなも同じに比べる）。「その他」は最後にお名前で並べる。元の配列は変えない", () => {
    const people = [
      person("山田 太郎", "やまだ たろう"),
      person("Bob"),
      person("佐藤 次郎"),
      person("沢田 紀孝", "サワダ ノリタカ"),
      person("あおい"),
      person("Alice"),
      person("加藤 花", "かとう はな"),
    ];
    expect(sortByReading(people).map((p) => p.personName)).toEqual([
      "あおい",
      "加藤 花",
      "沢田 紀孝",
      "山田 太郎",
      "Alice",
      "Bob",
      "佐藤 次郎",
    ]);
    expect(people[0].personName).toBe("山田 太郎");
  });

  it("同じ読みの人は元の並び（登録順）のまま", () => {
    const a = person("山田 A", "やまだ");
    const b = person("山田 B", "ヤマダ");
    expect(sortByReading([a, b])).toEqual([a, b]);
    expect(sortByReading([b, a])).toEqual([b, a]);
  });
});
