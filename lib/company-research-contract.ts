/** Main から非公開の分析 Worker に送る最小契約。管理画面の個人情報を含めない。 */
import { z } from "zod";

const researchUrlSchema = z.strictObject({
  slot: z.union([z.literal(1), z.literal(2)]),
  // 宛先のネットワーク安全性は巡回直前にも検証する。ここで取得は行わない。
  url: z.url({ protocol: /^https?$/ }).max(2048),
});

export type CompanyResearchUrl = z.infer<typeof researchUrlSchema>;

export const companyResearchEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  sourceId: z.string().min(1).max(128),
  sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventType: z.enum(["upsert", "revoke", "delete"]),
  urls: z.array(researchUrlSchema).max(2),
  urlFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.iso.datetime(),
}).superRefine((event, context) => {
  if ((event.eventType === "upsert") !== (event.urls.length > 0)) {
    context.addIssue({ code: "custom", path: ["urls"], message: "upsert requires URLs; revoke/delete require an empty array" });
  }
  if (new Set(event.urls.map(({ slot }) => slot)).size !== event.urls.length) {
    context.addIssue({ code: "custom", path: ["urls"], message: "URL slots must be unique" });
  }
});

export type CompanyResearchEvent = z.infer<typeof companyResearchEventSchema>;

/** fragment と既知の追跡パラメータだけを除去する。ページを区別する query は保持する。 */
export function canonicalizeResearchUrls(urls: readonly CompanyResearchUrl[]): CompanyResearchUrl[] {
  const seen = new Set<string>();
  return [...urls].sort((a, b) => a.slot - b.slot).flatMap(({ slot, url: value }) => {
    const url = new URL(value.trim());
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(name) || /^(gclid|fbclid|msclkid)$/i.test(name)) url.searchParams.delete(name);
    }
    const canonical = url.href;
    if (seen.has(canonical)) return [];
    seen.add(canonical);
    return [{ slot, url: canonical }];
  });
}

/** slot の入替えだけでは企業の対象 URL 集合は変わらない。 */
export async function computeResearchFingerprint(urls: readonly CompanyResearchUrl[]): Promise<string> {
  const values = canonicalizeResearchUrls(urls).map(({ url }) => url).sort();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildCompanyResearchEvent(input: {
  sourceId: string;
  sourceRevision: number;
  eventType: CompanyResearchEvent["eventType"];
  urls: readonly CompanyResearchUrl[];
  occurredAt?: string;
}): Promise<CompanyResearchEvent> {
  const urls = canonicalizeResearchUrls(input.urls);
  return companyResearchEventSchema.parse({
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    eventType: input.eventType,
    urls,
    urlFingerprint: await computeResearchFingerprint(urls),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}
