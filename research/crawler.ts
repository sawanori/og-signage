import { z } from "zod";
import { assertPublicUrl, resolvePublicHostname, type HostResolver } from "./url-policy";

export type PaidCallEstimate = {
  provider: "meta" | "crawl";
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  browserSeconds: number;
};
export type BeforePaidCall = (estimate: PaidCallEstimate) => Promise<void>;
export type PaidCallUsage = {
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
  reasoningTokens: number; costMicroUsd: number;
};

export class ProviderError extends Error {
  usage?: PaidCallUsage;
  details?: { reason: string; claimIndex: number };
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) { super(code); }
}

export function providerHttpError(response: Response): ProviderError {
  const retryHeader = response.headers.get("Retry-After");
  const seconds = retryHeader === null ? null : Number(retryHeader);
  const retryAt = retryHeader === null ? NaN : Date.parse(retryHeader);
  const retryAfterSeconds = seconds !== null && Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 3600)) :
    Number.isFinite(retryAt) ? Math.max(0, Math.min(Math.ceil((retryAt - Date.now()) / 1000), 3600)) : null;
  return new ProviderError(
    [401, 402, 403].includes(response.status) ? "provider_configuration_error" :
      response.status === 429 ? "provider_rate_limited" : `provider_http_${response.status}`,
    response.status === 429 || response.status >= 500,
    response.status, retryAfterSeconds,
  );
}

type CrawlAuth = { accountId: string; apiToken: string; fetcher?: typeof fetch };
const recordSchema = z.object({
  url: z.string(), status: z.union([z.string(), z.number()]),
  markdown: z.string().optional(), html: z.string().optional(),
  metadata: z.object({ url: z.string().optional(), title: z.string().optional(), status: z.number().optional() }).nullish().transform((value) => value ?? undefined),
});
const resultSchema = z.object({
  id: z.string(), status: z.string(), browserSecondsUsed: z.number().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(), finished: z.number().int().nonnegative().optional(),
  records: z.array(recordSchema).max(100).optional(), cursor: z.union([z.string(), z.number(), z.null()]).optional(),
});
const siteRejectionSchema = z.object({
  success: z.literal(false),
  errors: z.array(z.object({ message: z.literal("Crawl disallowed by Content-Signal directive (purpose or use level)") })).min(1),
});
export type CrawlRecord = z.infer<typeof recordSchema>;
export type CrawlResult = {
  id: string; status: string; browserSecondsUsed: number | null; total: number; finished: number;
  records: CrawlRecord[]; cursor: string | null;
};

function endpoint(accountId: string, id?: string): string {
  if (!/^[a-f\d]{32}$/iu.test(accountId) || (id !== undefined && !/^[\w-]{1,100}$/u.test(id))) {
    throw new ProviderError("invalid_provider_configuration", false);
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/crawl${id ? `/${id}` : ""}`;
}

async function request(auth: CrawlAuth, url: string, init: RequestInit): Promise<unknown> {
  if (!auth.apiToken) throw new ProviderError("missing_crawl_credentials", false);
  let response: Response;
  try {
    response = await (auth.fetcher ?? fetch)(url, {
      ...init,
      headers: { Authorization: `Bearer ${auth.apiToken}`, "Content-Type": "application/json" },
      // Never forward the API token to a redirect destination; non-2xx responses are rejected below.
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new ProviderError("provider_network_unknown", true); }
  if (!response.ok) {
    // Classify only the captured site-policy rejection from a crawl-start request.
    // Other 400s and authentication/configuration failures must still stop execution.
    if (init.method === "POST" && response.status === 400) {
      try {
        const body = await response.text();
        if (body.length <= 16_384 && siteRejectionSchema.safeParse(JSON.parse(body)).success) {
          throw new ProviderError("crawl_site_disallowed", false, 400);
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
      }
    }
    throw providerHttpError(response);
  }
  const text = await response.text();
  if (text.length > 12_000_000) throw new ProviderError("provider_response_too_large", false);
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new ProviderError("invalid_provider_response", false); }
  if (!data || typeof data !== "object" || !("success" in data) || data.success !== true || !("result" in data)) {
    throw new ProviderError("provider_rejected_request", false);
  }
  return data.result;
}

export async function startCrawl(input: CrawlAuth & {
  url: string; beforePaidCall: BeforePaidCall; resolveHostname?: HostResolver; limit?: number; depth?: number;
}): Promise<{ id: string }> {
  const url = await assertPublicUrl(input.url, input.resolveHostname ?? ((hostname) => resolvePublicHostname(hostname, input.fetcher)));
  const target = endpoint(input.accountId);
  if (!input.apiToken) throw new ProviderError("missing_crawl_credentials", false);
  const limit = input.limit ?? 50;
  const depth = input.depth ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(depth) || depth < 0 || depth > 5) {
    throw new ProviderError("invalid_crawl_limit", false);
  }
  await input.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 });
  const result = await request(input, target, {
    method: "POST",
    body: JSON.stringify({
      url, limit, depth, source: "all", formats: ["html", "markdown"], render: true,
      crawlPurposes: ["search", "ai-input", "ai-train"], contentUse: "full",
      options: { includeExternalLinks: false, includeSubdomains: false },
      rejectResourceTypes: ["image", "media", "font"],
      gotoOptions: { timeout: 20_000, waitUntil: "domcontentloaded" },
    }),
  });
  if (typeof result !== "string" || !/^[\w-]{1,100}$/u.test(result)) throw new ProviderError("invalid_provider_response", false);
  return { id: result };
}

export async function pollCrawl(input: CrawlAuth & { id: string; cursor?: string | null }): Promise<CrawlResult> {
  const url = new URL(endpoint(input.accountId, input.id));
  url.searchParams.set("limit", "10");
  if (input.cursor) url.searchParams.set("cursor", input.cursor);
  const result = resultSchema.safeParse(await request(input, url.href, { method: "GET" }));
  if (!result.success) throw new ProviderError("invalid_provider_response", false);
  return {
    id: result.data.id, status: result.data.status, browserSecondsUsed: result.data.browserSecondsUsed ?? null,
    total: result.data.total ?? 0, finished: result.data.finished ?? 0, records: result.data.records ?? [],
    cursor: result.data.cursor === undefined || result.data.cursor === null ? null : String(result.data.cursor),
  };
}

export async function cancelCrawl(input: CrawlAuth & { id: string }): Promise<void> {
  await request(input, endpoint(input.accountId, input.id), { method: "DELETE" });
}
