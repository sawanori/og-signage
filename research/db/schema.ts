import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { CompanyResearchUrl } from "../../lib/company-research-contract";

export const researchNow = () => Math.floor(Date.now() / 1000);
const timestamp = (name: string) => integer(name).notNull().$defaultFn(researchNow);
export type ResearchProgress = Record<string, unknown>;

// These tables belong exclusively to the research database, never the signage DB.
export const researchEvents = sqliteTable("research_events", {
  eventId: text("event_id").primaryKey(), payloadHash: text("payload_hash").notNull(),
  sourceId: text("source_id").notNull(), sourceRevision: integer("source_revision").notNull(),
  eventType: text("event_type", { enum: ["upsert", "revoke", "delete"] }).notNull(),
  receivedAt: timestamp("received_at"),
});

export const researchSubjects = sqliteTable("research_subjects", {
  sourceId: text("source_id").primaryKey(), sourceRevision: integer("source_revision").notNull(),
  urlFingerprint: text("url_fingerprint").notNull(),
  status: text("status", { enum: ["active", "revoked", "deleted"] }).notNull(),
  generation: integer("generation").notNull().default(0),
  currentJobId: text("current_job_id"), currentProfileId: text("current_profile_id"),
  lastSuccessfulCrawlAt: integer("last_successful_crawl_at"),
  purgeAfter: integer("purge_after"), purgedAt: integer("purged_at"),
  createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
}, (t) => [index("research_subjects_purge_idx").on(t.purgeAfter)]);

export const researchJobs = sqliteTable("research_jobs", {
  jobId: text("job_id").primaryKey(), sourceId: text("source_id").notNull().references(() => researchSubjects.sourceId),
  generation: integer("generation").notNull(), urlFingerprint: text("url_fingerprint").notNull(),
  urls: text("urls_json", { mode: "json" }).$type<CompanyResearchUrl[]>().notNull(),
  phase: text("phase").notNull().default("crawl"),
  status: text("status", { enum: ["queued", "running", "retry", "budget_exhausted", "configuration_required", "failed", "succeeded", "superseded"] }).notNull().default("queued"),
  progress: text("progress_json", { mode: "json" }).$type<ResearchProgress>().notNull().$defaultFn(() => ({})),
  attempts: integer("attempts").notNull().default(0), nextRunAt: timestamp("next_run_at"),
  leaseToken: text("lease_token"), leaseExpiresAt: integer("lease_expires_at"),
  lastErrorCode: text("last_error_code"), createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
  completedAt: integer("completed_at"), purgeAfter: integer("purge_after"),
}, (t) => [uniqueIndex("research_jobs_generation_unique").on(t.sourceId, t.generation), index("research_jobs_due_idx").on(t.status, t.nextRunAt, t.leaseExpiresAt)]);

export const researchPages = sqliteTable("research_pages", {
  pageId: text("page_id").primaryKey(), jobId: text("job_id").notNull().references(() => researchJobs.jobId),
  sourceId: text("source_id").notNull(), canonicalUrl: text("canonical_url").notNull(),
  contentHash: text("content_hash"), markdownKey: text("markdown_key"), rawKey: text("raw_key"),
  title: text("title"), status: text("status").notNull(), exclusionReason: text("exclusion_reason"),
  fetchedAt: timestamp("fetched_at"), rawExpiresAt: integer("raw_expires_at"),
}, (t) => [uniqueIndex("research_pages_url_unique").on(t.jobId, t.canonicalUrl), index("research_pages_raw_expiry_idx").on(t.rawExpiresAt)]);

export const researchProfiles = sqliteTable("research_profiles", {
  profileId: text("profile_id").primaryKey(), sourceId: text("source_id").notNull(),
  jobId: text("job_id").notNull().references(() => researchJobs.jobId), generation: integer("generation").notNull(),
  contentHash: text("content_hash").notNull(), schemaVersion: integer("schema_version").notNull(),
  model: text("model").notNull(), promptVersion: text("prompt_version").notNull(),
  payload: text("payload_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  extractedAt: timestamp("extracted_at"), createdAt: timestamp("created_at"),
}, (t) => [uniqueIndex("research_profiles_generation_unique").on(t.sourceId, t.generation)]);

export const researchUsage = sqliteTable("research_usage", {
  reservationId: text("reservation_id").primaryKey(), jobId: text("job_id").notNull().references(() => researchJobs.jobId),
  operationKey: text("operation_key").notNull(),
  provider: text("provider", { enum: ["meta", "crawl"] }).notNull(), month: text("month").notNull(),
  status: text("status", { enum: ["reserved", "started", "settled", "unknown", "cancelled"] }).notNull(),
  reservedMicrousd: integer("reserved_microusd").notNull(), chargedMicrousd: integer("charged_microusd").notNull(),
  inputTokenLimit: integer("input_token_limit").notNull().default(0), outputTokenLimit: integer("output_token_limit").notNull().default(0),
  inputTokens: integer("input_tokens"), outputTokens: integer("output_tokens"), cachedTokens: integer("cached_tokens"), reasoningTokens: integer("reasoning_tokens"),
  priceVersion: text("price_version").notNull(), createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
  leaseTokenAtStart: text("lease_token_at_start"), providerRequestId: text("provider_request_id"), providerFinishedAt: integer("provider_finished_at"),
}, (t) => [uniqueIndex("research_usage_operation_unique").on(t.jobId, t.operationKey), index("research_usage_month_idx").on(t.provider, t.month), check("research_usage_nonnegative", sql`${t.reservedMicrousd} >= 0 AND ${t.chargedMicrousd} >= 0 AND ${t.inputTokenLimit} >= 0 AND ${t.outputTokenLimit} >= 0`)]);

// Durable operational pause/provider stops, independent of per-invocation env flags.
export const researchControls = sqliteTable("research_controls", {
  key: text("key").primaryKey(), value: text("value_json", { mode: "json" }).$type<ResearchProgress>().notNull(), updatedAt: timestamp("updated_at"),
});

export type ResearchJob = typeof researchJobs.$inferSelect;
export type ResearchPage = typeof researchPages.$inferSelect;
export type ResearchProfile = typeof researchProfiles.$inferSelect;
