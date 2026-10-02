/**
 * 管理画面の「企業データ」用。分析 Worker から Service Binding で現在の企業データを読み、掲載メンバーの名前と合わせる。
 * 読むだけで、分析側にもメインの DB にも書かない。サイネージ・公開ページ・端末には出さない。
 */
import { z } from "zod";
import type { Db } from "../../db/index";
import type { CompanyResearchServiceBinding } from "../../worker/company-research-dispatch";
import { listSpotlights } from "./spotlights";

const claim = z.object({ text: z.string(), kind: z.string(), sourceIds: z.array(z.string()).catch([]), evidenceText: z.string().catch("") });
const claims = z.array(claim).catch([]);
export const companyProfileSchema = z.object({
  company: z.object({ name: claim.nullable().catch(null), summary: claim.nullable().catch(null), industries: claims, regions: claims }).catch({ name: null, summary: null, industries: [], regions: [] }),
  services: z.array(z.object({
    name: claim, description: claim.nullable().catch(null),
    targetCustomers: claims, problemsSolved: claims, delivery: claims, pricing: claims,
  })).catch([]),
  strengths: claims,
  limitations: claims,
  unknowns: z.array(z.string()).catch([]),
  sourceConflicts: claims,
  sources: z.array(z.object({ sourceId: z.string(), url: z.string() })).catch([]),
  coverage: z.object({
    inputUrls: z.array(z.string()).catch([]), fetched: z.number().catch(0), processed: z.number().catch(0),
    skipped: z.array(z.object({ url: z.string(), reason: z.string() })).catch([]),
    reasons: z.array(z.string()).catch([]), status: z.string().catch("partial"), lastFetchedAt: z.string().nullable().catch(null),
  }).nullable().catch(null),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
export type CompanyClaim = z.infer<typeof claim>;

const listSchema = z.object({ data: z.array(z.object({
  sourceId: z.string(),
  lastSuccessfulCrawlAt: z.number().nullable(),
  job: z.object({ status: z.string(), phase: z.string(), lastErrorCode: z.string().nullable(), updatedAt: z.number(), urls: z.array(z.object({ slot: z.number(), url: z.string() })) }).nullable(),
  profile: z.object({ payload: z.unknown(), extractedAt: z.number(), createdAt: z.number() }).nullable(),
})) });

export type CompanyResearchEntry = {
  sourceId: string;
  /** 掲載メンバーの名前（メンバーが削除済みで分析側だけに残っている場合は null） */
  member: { companyName: string; personName: string } | null;
  urls: string[];
  status: "done" | "working" | "failed" | "waiting";
  errorCode: string | null;
  updatedAt: number | null;
  profile: (CompanyProfile & { extractedAt: number }) | null;
};

const WORKING = ["queued", "running", "retry"];

/** 分析 Worker に届かない・応答が壊れているときは null（画面で「読み込めません」を出す） */
export async function loadCompanyResearch(db: Db, binding: CompanyResearchServiceBinding | undefined): Promise<CompanyResearchEntry[] | null> {
  if (!binding) return null;
  let parsed: z.infer<typeof listSchema>;
  try {
    const response = await binding.fetch("https://company-research.internal/internal/profiles", { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    parsed = listSchema.parse(await response.json());
  } catch { return null; }
  const members = new Map((await listSpotlights(db)).map((row) => [row.id, row]));
  return parsed.data.map((item) => {
    const member = members.get(item.sourceId);
    const status: CompanyResearchEntry["status"] = item.job === null ? "waiting" : WORKING.includes(item.job.status) ? "working"
      : item.job.status === "succeeded" ? "done" : item.job.status === "superseded" ? "working" : "failed";
    const payload = item.profile ? companyProfileSchema.safeParse(item.profile.payload) : null;
    return {
      sourceId: item.sourceId,
      member: member ? { companyName: member.companyName, personName: member.personName } : null,
      urls: item.job?.urls.map((entry) => entry.url) ?? [],
      status,
      errorCode: item.job?.lastErrorCode ?? null,
      updatedAt: item.job?.updatedAt ?? null,
      profile: payload?.success ? { ...payload.data, extractedAt: item.profile!.extractedAt } : null,
    };
  }).sort((a, b) => (a.member?.companyName ?? "\uffff").localeCompare(b.member?.companyName ?? "\uffff", "ja"));
}
