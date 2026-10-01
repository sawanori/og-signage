import { normalizeResearchUrl } from "./url-policy";

export type UnsupportedResearchLink = { url: string; reason: "unsupported_format" };
export type SanitizedPage = {
  status: "ready" | "privacy_review_required" | "empty" | "unsupported";
  markdown: string;
  reasons: string[];
  removedLines: number;
  unsupportedLinks: UnsupportedResearchLink[];
};

const unsupportedExtension = /\.(?:pdf|docx?|xlsx?|pptx?|mp[34]|webm|png|jpe?g|gif|svg)(?:$|\/)/iu;

export function discoverUnsupportedLinks(input: { url: string; markdown: string; html?: string }): UnsupportedResearchLink[] {
  const candidates: string[] = [];
  for (const match of input.markdown.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/gu)) {
    candidates.push(match[1].replace(/^<|>$/gu, ""));
  }
  for (const match of (input.html ?? "").matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)) {
    candidates.push(match[1] ?? match[2] ?? match[3]);
  }
  const urls = new Set<string>();
  for (const candidate of candidates) {
    try {
      const resolved = new URL(candidate.replace(/&amp;/giu, "&"), input.url);
      if (!unsupportedExtension.test(decodeURIComponent(resolved.pathname))) continue;
      urls.add(normalizeResearchUrl(resolved.href));
    } catch { /* Do not persist unsafe or malformed link destinations. */ }
  }
  return [...urls].map((url) => ({ url, reason: "unsupported_format" }));
}

const personalSection = /(?:スタッフ|社員紹介|メンバー紹介|代表(?:者)?紹介|代表挨拶|経歴|略歴|プロフィール|採用応募|お問い合わせ|プライバシー|個人情報|privacy|contact|biograph|our\s+team|staff|leadership|founder|executive)/iu;
const personalLine = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d ()-]{7,}\d)|(?:代表取締役|代表者|代表社員|氏名|生年月日|電話|携帯|FAX|TEL|住所|所在地|役員|担当者|CEO|CTO|founder|born|e-?mail|phone|address|author|[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:is|was))\s*[:：|\s])/iu;
const ambiguousPersonal = /(?:\b(?:Mr|Mrs|Ms|Dr)\.?\s+\p{L}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,8}(?:氏|さん|様)|(?:私|僕)は|\bI (?:am|was|have)\b|[\p{Script=Han}]{1,4}[ 　]+[\p{Script=Han}\p{Script=Hiragana}]{1,4}(?:\s|$)|(?:代表(?!的)|取締役|スタッフ|社員|創業者|創設者|設立者|責任者|技術者|デザイナー|カメラマン|著者|執筆者|氏名|経歴|略歴|生年月日|founder|chief executive))/iu;
const injectedInstruction = /(?:ignore (?:all |previous |the )?(?:instructions|prompt)|system\s*prompt|developer\s*message|api[_ -]?key|secret[_ -]?key|前の指示を無視|以前の指示を無視|システムプロンプト|秘密鍵)/iu;
const businessNameWord = /\b(?:Company|Services?|Business|Products?|Solutions?|Technology|Development|Design|Support|Pricing|Works?|Overview|Corporate|Limited|Studio|Agency|Systems?|Cloud|Labs?|Digital|Media|Video|Web|Creative|Marketing|Consulting|Research|LLC|Inc|Ltd)\b/u;

const definiteEmail = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu;
const definiteBirthDate = /(?:生年月日|date\s+of\s+birth)/iu;
const phoneCandidate = /\+?\d[\d ()-]{7,}\d/gu;

/** Output check: only data that is personal regardless of context. Ambiguous wording was already removed from the input. */
export function containsDefinitePersonalData(value: string): boolean {
  if (definiteEmail.test(value) || definiteBirthDate.test(value)) return true;
  return [...value.matchAll(phoneCandidate)].some((match) => match[0].replace(/\D/gu, "").length >= 10);
}

export function hasAmbiguousPersonName(value: string): boolean {
  const names = value.match(/\b[A-Z][a-z]{1,30}(?:[ -][A-Z][a-z]{1,30}){1,2}\b/gu) ?? [];
  return names.some((name) => !businessNameWord.test(name));
}

/** Conservative screening: lines that may identify a person are removed, never assumed safe. Personal pages are withheld whole. */
export function sanitizePage(input: { url: string; title?: string; markdown: string; html?: string }): SanitizedPage {
  const reasons = new Set<string>();
  const unsupportedLinks = discoverUnsupportedLinks(input);
  const path = (() => { try { return decodeURIComponent(new URL(input.url).pathname); } catch { return ""; } })();
  if (unsupportedExtension.test(path)) {
    return { status: "unsupported", markdown: "", reasons: ["unsupported_format"], removedLines: 0, unsupportedLinks };
  }
  if (/(?:^|\/)(?:staff|team|people|members|profile|biography|recruit|contact|privacy)(?:\/|$)/iu.test(path) ||
      personalSection.test(input.title ?? "")) {
    return { status: "privacy_review_required", markdown: "", reasons: ["personal_page"], removedLines: 0, unsupportedLinks };
  }
  if (new TextEncoder().encode(input.markdown).length > 1_000_000) {
    return { status: "unsupported", markdown: "", reasons: ["page_size_limit"], removedLines: 0, unsupportedLinks };
  }
  const cleaned = input.markdown
    .replace(/<(script|style|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/https?:\/\/[^\s)\]>]+/gu, "")
    .replace(/\u0000/gu, "");
  const lines = cleaned.split(/\r?\n/u);
  const kept: string[] = [];
  let removedLines = 0;
  let blockedHeadingLevel: number | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading && blockedHeadingLevel !== null && heading[1].length <= blockedHeadingLevel) blockedHeadingLevel = null;
    // A section headed by possibly personal wording (e.g. 代表メッセージ, お客様の声) is removed as a whole.
    // English capitalized headings are usually product names, so only that line is removed below.
    if (heading && (personalSection.test(heading[2]) || ambiguousPersonal.test(heading[2]))) blockedHeadingLevel = heading[1].length;
    if (blockedHeadingLevel !== null || /^\s*(?:\|\s*)?(?:full\s+)?name\s*[:：|]/iu.test(line) || personalLine.test(line) || personalSection.test(line) || injectedInstruction.test(line)) {
      removedLines += 1;
      reasons.add(injectedInstruction.test(line) ? "embedded_instruction_removed" : "personal_content_removed");
      continue;
    }
    if (ambiguousPersonal.test(line) || hasAmbiguousPersonName(line)) {
      // Remove only the line: one footer such as "All Rights Reserved" must not discard the whole business page.
      removedLines += 1;
      reasons.add("ambiguous_personal_content_removed");
      continue;
    }
    kept.push(line.trimEnd());
  }
  const markdown = kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (markdown.length < 20) return { status: "empty", markdown: "", reasons: [...reasons, "insufficient_business_text"], removedLines, unsupportedLinks };
  return { status: "ready", markdown, reasons: [...reasons], removedLines, unsupportedLinks };
}
