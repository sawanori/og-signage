import { z } from "zod";

export const RESEARCH_MODEL = "muse-spark-1.3-contributor";
export const RESEARCH_PROMPT_VERSION = "company-research-v3";

export const claimSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  kind: z.enum(["fact", "site_claim", "inference"]),
  sourceIds: z.array(z.string().min(1).max(100)).min(1).max(20),
  evidenceText: z.string().trim().min(1).max(2000),
}).strict();

export const profileContentSchema = z.object({
  company: z.object({
    name: claimSchema.nullable(),
    summary: claimSchema.nullable(),
    industries: z.array(claimSchema).max(20),
    regions: z.array(claimSchema).max(30),
  }).strict(),
  services: z.array(z.object({
    name: claimSchema,
    description: claimSchema.nullable(),
    targetCustomers: z.array(claimSchema).max(20),
    problemsSolved: z.array(claimSchema).max(20),
    delivery: z.array(claimSchema).max(20),
    pricing: z.array(claimSchema).max(20),
  }).strict()).max(50),
  strengths: z.array(claimSchema).max(30),
  limitations: z.array(claimSchema).max(30),
  unknowns: z.array(z.string().min(1).max(500)).max(30),
  sourceConflicts: z.array(claimSchema).max(20),
}).strict();

export type ResearchClaim = z.infer<typeof claimSchema>;
export type ProfileContent = z.infer<typeof profileContentSchema>;
export type EvidencePage = { sourceId: string; markdown: string };
export type ExtractedProfile = ProfileContent & {
  schemaVersion: 1;
  sourceId: string;
  generation: number;
  model: typeof RESEARCH_MODEL;
  promptVersion: typeof RESEARCH_PROMPT_VERSION;
  extractedAt: string;
};

// Keep the provider schema within its strict subset; bounds are checked locally.
const claimJsonSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    kind: { type: "string", enum: ["fact", "site_claim", "inference"] },
    sourceIds: { type: "array", items: { type: "string" } },
    evidenceText: { type: "string" },
  },
  required: ["text", "kind", "sourceIds", "evidenceText"],
  additionalProperties: false,
};
const claims = { type: "array", items: claimJsonSchema };
const nullableClaim = { anyOf: [claimJsonSchema, { type: "null" }] };
const serviceProperties = {
  name: claimJsonSchema,
  description: nullableClaim,
  targetCustomers: claims,
  problemsSolved: claims,
  delivery: claims,
  pricing: claims,
};
const companyProperties = {
  name: nullableClaim,
  summary: nullableClaim,
  industries: claims,
  regions: claims,
};
const profileProperties = {
  company: {
    type: "object", properties: companyProperties,
    required: Object.keys(companyProperties), additionalProperties: false,
  },
  services: {
    type: "array",
    items: {
      type: "object", properties: serviceProperties,
      required: Object.keys(serviceProperties), additionalProperties: false,
    },
  },
  strengths: claims,
  limitations: claims,
  unknowns: { type: "array", items: { type: "string" } },
  sourceConflicts: claims,
};
export const PROFILE_JSON_SCHEMA = {
  type: "object", properties: profileProperties,
  required: Object.keys(profileProperties), additionalProperties: false,
};
