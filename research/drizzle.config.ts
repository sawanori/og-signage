import { defineConfig } from "drizzle-kit";

const url = process.env.RESEARCH_DATABASE_URL?.trim();
if (!url) throw new Error("RESEARCH_DATABASE_URL must explicitly target the research database");
export default defineConfig({
  schema: "./research/db/schema.ts", out: "./research/db/migrations", dialect: "turso",
  dbCredentials: { url, authToken: process.env.RESEARCH_AUTH_TOKEN },
});
