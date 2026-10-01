import type { ResearchDatabaseConfig } from "./db/client";

export interface ResearchBucket {
  put(key: string, value: string | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string | string[]): Promise<void>;
}
export interface ResearchEnv extends ResearchDatabaseConfig {
  RESEARCH_BUCKET: ResearchBucket;
  MODEL_API_KEY?: string;
  CRAWL_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  RESEARCH_PAID_ENABLED?: string;
  RESEARCH_CANARY_SOURCE_IDS?: string;
}

export function paidSourceAllowed(env: Pick<ResearchEnv, "RESEARCH_PAID_ENABLED" | "RESEARCH_CANARY_SOURCE_IDS">, sourceId: string): boolean {
  if (env.RESEARCH_PAID_ENABLED === "true") return true;
  return (env.RESEARCH_CANARY_SOURCE_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean).includes(sourceId);
}
