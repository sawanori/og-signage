import { describe, expect, it, vi } from "vitest";
import { cancelCrawl, pollCrawl, ProviderError, startCrawl } from "../../research/crawler";
import { extractProfile } from "../../research/meta";
import type { ProfileContent } from "../../research/profile-schema";
import { PROFILE_JSON_SCHEMA } from "../../research/profile-schema";
import realSyntheticExtraction from "./fixtures/meta-extraction-success.json";
import realConflictingExtraction from "./fixtures/meta-conflict-success.json";
import { profileClaims } from "../../research/evidence";
import providerProbe from "../../docs/reviews/company-research-provider-probe.json";

const accountId = "a".repeat(32);
const auth = { accountId, apiToken: "test-token" };
const markdown = "当社は企業向けのWeb制作と保守サービスを提供します。対応地域は東京と横浜です。";
const claim = { text: "Web制作", kind: "site_claim" as const, sourceIds: ["page_1"], evidenceText: "Web制作と保守サービス" };
const profile: ProfileContent = {
  company: { name: null, summary: claim, industries: [], regions: [] },
  services: [], strengths: [], limitations: [], unknowns: ["料金は不明"], sourceConflicts: [],
};
function metaResponse(content: unknown = profile) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 80 } },
  }));
}

describe("private research provider adapters", () => {
  it("accepts the captured real Contributor response for the synthetic public fixture", async () => {
    const result = await extractProfile({ apiKey: "test-secret", sourceId: "member_fixture", generation: 1,
      pages: realSyntheticExtraction.pages, beforePaidCall: async () => {},
      fetcher: async () => new Response(JSON.stringify(realSyntheticExtraction.response)),
    });
    expect(result.profile.services.map((service) => service.name.text)).toEqual(["Webサイト制作", "映像制作"]);
    expect(result.profile.limitations[0]?.text).toBe("撮影のみの依頼には対応していない");
    expect(result.profile.strengths[0]?.kind).toBe("site_claim");
    expect(result.usage.costMicroUsd).toBe(402);
  });
  it("retains other-company facts and conflicting prices from the real API response without merging their attribution", async () => {
    const { profile } = await extractProfile({ apiKey: "test-secret", sourceId: "member_fixture", generation: 1,
      pages: realConflictingExtraction.pages, beforePaidCall: async () => {},
      fetcher: async () => new Response(JSON.stringify(realConflictingExtraction.response)),
    });
    expect(profile.company.name?.text).toBe("Alpha Studio株式会社");
    const prices = profileClaims(profile).filter((claim) => /万円/u.test(claim.text));
    expect(prices).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("10万円"), sourceIds: ["alpha_main"] }),
      expect.objectContaining({ text: expect.stringContaining("15万円"), sourceIds: ["alpha_pricing"] }),
      expect.objectContaining({ text: expect.stringContaining("20万円"), sourceIds: ["beta_main"] }),
    ]));
    expect(profile.sourceConflicts.some((claim) => claim.sourceIds.includes("beta_main") && claim.text.includes("Webサイト制作"))).toBe(true);
    expect(profile.services.every((service) => service.name.sourceIds.every((id) => id.startsWith("alpha_")))).toBe(true);
  });
  it("reserves before starting a bounded crawl with honest training purposes", async () => {
    const events: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      events.push("fetch");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        limit: 50, depth: 5, formats: ["html", "markdown"], render: true,
        crawlPurposes: ["search", "ai-input", "ai-train"], contentUse: "full",
        options: { includeExternalLinks: false, includeSubdomains: false },
      });
      return new Response(JSON.stringify({ success: true, result: "crawl-1" }));
    });
    const beforePaidCall = vi.fn(async (estimate) => {
      events.push("reserve");
      expect(estimate).toMatchObject({ provider: "crawl", costMicroUsd: 30_000 });
    });
    await expect(startCrawl({ ...auth, url: "https://company.example/", resolveHostname: async () => ["1.1.1.1"], beforePaidCall, fetcher })).resolves.toEqual({ id: "crawl-1" });
    expect(events).toEqual(["reserve", "fetch"]);
  });

  it("does not start paid work if budget reservation or DNS fails", async () => {
    const fetcher = vi.fn();
    const beforePaidCall = vi.fn(async () => { throw new Error("budget_exhausted"); });
    await expect(startCrawl({ ...auth, url: "https://company.example", resolveHostname: async () => ["1.1.1.1"], beforePaidCall, fetcher })).rejects.toThrow("budget_exhausted");
    await expect(startCrawl({ ...auth, url: "https://company.example", resolveHostname: async () => ["127.0.0.1"], beforePaidCall, fetcher })).rejects.toThrow("public website");
    expect(beforePaidCall).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies the captured Content-Signal refusal as a site-specific start rejection without exposing its body", async () => {
    const captured = providerProbe.crawl.find((item) => item.case === "content_signal_block")!;
    const beforePaidCall = vi.fn(async () => {});
    const error = await startCrawl({ ...auth, url: "https://company.example/", resolveHostname: async () => ["1.1.1.1"], beforePaidCall,
      fetcher: async () => new Response(JSON.stringify(captured.start), { status: captured.startStatus }),
    }).catch((error: unknown) => error);
    expect(beforePaidCall).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "crawl_site_disallowed", retryable: false, status: 400, message: "crawl_site_disallowed" });
  });

  it.each([
    { status: 400, body: { success: false, errors: [{ message: 'Unrecognized key: "crawlUseLevel"' }] }, code: "provider_http_400" },
    { status: 400, body: { success: false, errors: [{ message: "Crawl disallowed by Content-Signal directive (purpose or use level)" }, { message: "Invalid credentials" }] }, code: "provider_http_400" },
    { status: 403, body: { success: false, errors: [{ message: "Crawl disallowed by Content-Signal directive (purpose or use level)" }] }, code: "provider_configuration_error" },
  ])("does not treat other start errors as site rejection ($status/$code)", async ({ status, body, code }) => {
    await expect(startCrawl({ ...auth, url: "https://company.example/", resolveHostname: async () => ["1.1.1.1"], beforePaidCall: async () => {},
      fetcher: async () => new Response(JSON.stringify(body), { status }),
    })).rejects.toMatchObject({ code, retryable: false, status });
  });

  it("parses pages, browser usage and pagination without discarding disallowed records", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("cursor=5");
      return new Response(JSON.stringify({ success: true, result: {
      id: "crawl-1", status: "completed", browserSecondsUsed: 3.5, total: 2, finished: 2,
      records: [{ url: "https://company.example/", status: "completed", markdown, metadata: { status: 200 } },
        { url: "https://company.example/private", status: "disallowed" }], cursor: 10,
      } }));
    });
    const result = await pollCrawl({ ...auth, id: "crawl-1", cursor: "5", fetcher });
    expect(result).toMatchObject({ browserSecondsUsed: 3.5, cursor: "10", records: [{ status: "completed" }, { status: "disallowed" }] });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("cursor=5");
  });

  it("cancels by DELETE and marks authentication failures nonretryable", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ success: true, result: null }));
    });
    await cancelCrawl({ ...auth, id: "crawl-1", fetcher });
    await expect(pollCrawl({ ...auth, id: "crawl-1", fetcher: async () => new Response("secret provider detail", { status: 403 }) }))
      .rejects.toMatchObject({ code: "provider_configuration_error", retryable: false, status: 403 });
  });

  it("does not turn absent terminal crawl usage into a free call", async () => {
    const result = await pollCrawl({ ...auth, id: "crawl-1", fetcher: async () => new Response(JSON.stringify({
      success: true, result: { id: "crawl-1", status: "completed", records: [] },
    })) });
    expect(result.browserSecondsUsed).toBeNull();
  });

  it("normalizes null metadata on a real-shape cancelled record", async () => {
    const result = await pollCrawl({ ...auth, id: "crawl-1", fetcher: async () => new Response(JSON.stringify({
      success: true, result: { id: "crawl-1", status: "cancelled_by_user", browserSecondsUsed: 0,
        records: [{ url: "https://company.example/", status: "cancelled", metadata: null }] },
    })) });
    expect(result.status).toBe("cancelled_by_user");
    expect(result.records[0]?.metadata).toBeUndefined();
    expect(result.browserSecondsUsed).toBe(0);
  });

  it("uses Contributor strict JSON, strips metadata from prompts and accounts for reasoning once", async () => {
    let sentBody = "";
    const beforePaidCall = vi.fn(async () => {});
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(beforePaidCall).toHaveBeenCalledTimes(1);
      sentBody = String(init?.body);
      return metaResponse();
    });
    const result = await extractProfile({ apiKey: "test-secret", sourceId: "member_1", generation: 2,
      pages: [{ sourceId: "page_1", markdown }], beforePaidCall, fetcher, now: new Date("2026-10-01T00:00:00Z") });
    expect(JSON.parse(sentBody)).toMatchObject({
      model: "muse-spark-1.3-contributor", reasoning_effort: "minimal",
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(sentBody).not.toContain("member_1");
    expect(sentBody).not.toContain("test-secret");
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100, reasoningTokens: 80, costMicroUsd: 131 });
    expect(result.profile).toMatchObject({ sourceId: "member_1", generation: 2, extractedAt: "2026-10-01T00:00:00.000Z" });
  });

  it("rejects unsanitized input before any reservation or Meta request", async () => {
    const fetcher = vi.fn();
    const beforePaidCall = vi.fn();
    await expect(extractProfile({ apiKey: "test-secret", sourceId: "member_1", generation: 1,
      pages: [{ sourceId: "page_1", markdown: markdown + "\n担当者: 山田 太郎 person@example.com" }], beforePaidCall, fetcher }))
      .rejects.toMatchObject({ code: "unsanitized_model_input" });
    expect(beforePaidCall).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects fabricated evidence and never retries invalid output implicitly", async () => {
    const fetcher = vi.fn(async () => metaResponse({ ...profile, strengths: [{ ...claim, evidenceText: "全国最安値を保証" }] }));
    await expect(extractProfile({ apiKey: "test-secret", sourceId: "member_1", generation: 1,
      pages: [{ sourceId: "page_1", markdown }], beforePaidCall: async () => {}, fetcher })).rejects.toMatchObject({
        code: "invalid_evidence", retryable: true, details: { reason: "quote_not_found", claimIndex: 1 },
        usage: { costMicroUsd: 131 },
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects generated personal contacts even with a matching but unrelated quote", async () => {
    const fetcher = vi.fn(async () => metaResponse({ ...profile, company: { ...profile.company,
      summary: { ...claim, text: "連絡先はperson@example.comです" },
    } }));
    await expect(extractProfile({ apiKey: "test-secret", sourceId: "member_1", generation: 1,
      pages: [{ sourceId: "page_1", markdown }], beforePaidCall: async () => {}, fetcher }))
      .rejects.toMatchObject({ code: "private_model_output" });
  });

  it("rejects a generated personal name inside a JSON field", async () => {
    await expect(extractProfile({ apiKey: "test-secret", sourceId: "member_1", generation: 1,
      pages: [{ sourceId: "page_1", markdown }], beforePaidCall: async () => {},
      fetcher: async () => metaResponse({ ...profile, company: { ...profile.company, name: { ...claim, text: "Alice Johnson" } } }),
    })).rejects.toMatchObject({ code: "private_model_output", retryable: false });
  });

  it("retains uncertainty on network failure and caps Retry-After", async () => {
    const input = { apiKey: "test-secret", sourceId: "member_1", generation: 1,
      pages: [{ sourceId: "page_1", markdown }], beforePaidCall: async () => {} };
    await expect(extractProfile({ ...input, fetcher: async () => { throw new Error("sensitive network detail"); } })).rejects.toEqual(new ProviderError("provider_network_unknown", true));
    await expect(extractProfile({ ...input, fetcher: async () => new Response("", { status: 429, headers: { "Retry-After": "9000" } }) }))
      .rejects.toMatchObject({ code: "provider_rate_limited", retryable: true, retryAfterSeconds: 3600 });
  });

  it("uses the provider strict subset for every object", () => {
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const value = node as Record<string, unknown>;
      if (value.type === "object") {
        expect(value.additionalProperties).toBe(false);
        expect(value.required).toEqual(Object.keys(value.properties as object));
      }
      expect(value).not.toHaveProperty("oneOf");
      expect(value).not.toHaveProperty("allOf");
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    };
    visit(PROFILE_JSON_SCHEMA);
  });
});
