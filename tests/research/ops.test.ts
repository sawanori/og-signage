import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { buildCompanyResearchEvent } from "../../lib/company-research-contract";
import { acceptResearchEvent } from "../../research/intake";
import { researchControls, researchJobs, researchProfiles, researchSubjects, researchUsage } from "../../research/db/schema";
import { openTestResearchDatabase } from "./db-helper";

const connections: Awaited<ReturnType<typeof openTestResearchDatabase>>[] = [];
afterEach(() => { for (const c of connections.splice(0)) c.close(); });
async function setup() {
  const connection = await openTestResearchDatabase(); connections.push(connection);
  await acceptResearchEvent(connection.db, await buildCompanyResearchEvent({ sourceId: "cli-member", sourceRevision: 0, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }] }), 100);
  const [job] = await connection.db.select().from(researchJobs);
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/company-research-ops.ts", ...args], { cwd: process.cwd(), env: { NODE_ENV: "test", PATH: process.env.PATH, RESEARCH_DATABASE_URL: connection.url }, encoding: "utf8", timeout: 20_000 });
  return { ...connection, job, cli };
}

describe("private operator CLI on a real research database", () => {
  it("shows status/usage, applies pause/resume, and schedules a stopped job without erasing usage", async () => {
    const x = await setup();
    await x.db.insert(researchUsage).values({ reservationId: "prior-call", jobId: x.job.jobId, operationKey: "initial:crawl:0", provider: "crawl", month: "2026-10", status: "unknown", reservedMicrousd: 30_000, chargedMicrousd: 30_000, priceVersion: "test" });
    await x.db.update(researchJobs).set({ status: "failed", attempts: 3, lastErrorCode: "provider_network_unknown" }).where(eq(researchJobs.jobId, x.job.jobId));
    const status = x.cli("status");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).jobs[0]).toMatchObject({ jobId: x.job.jobId, status: "failed", attempts: 3 });
    const usage = x.cli("usage");
    expect(usage.status, usage.stderr).toBe(0);
    expect(JSON.parse(usage.stdout)[0]).toMatchObject({ chargedMicroUsd: 30_000, calls: 1, status: "unknown" });
    expect(x.cli("pause").status).toBe(0);
    expect((await x.db.select().from(researchControls))[0].value).toEqual({ paused: true });
    expect(x.cli("resume").status).toBe(0);
    expect((await x.db.select().from(researchControls))[0].value).toEqual({ paused: false });
    const retry = x.cli("retry", x.job.jobId);
    expect(retry.status, retry.stderr).toBe(0);
    const [retried] = await x.db.select().from(researchJobs);
    expect(retried).toMatchObject({ status: "retry", attempts: 0, phase: "crawl" });
    expect(retried.progress.manualRetryToken).toMatch(/^[a-f\d-]{36}$/);
    expect((await x.db.select().from(researchUsage))[0]).toMatchObject({ reservationId: "prior-call", chargedMicrousd: 30_000, status: "unknown" });
  });

  it("exports only the active current profile privately and rejects completed-phase retry", async () => {
    const x = await setup();
    const payload = { company: { name: "fixture company" }, services: [], evidence: "private-profile-marker" };
    await x.db.insert(researchProfiles).values({ profileId: "current-profile", sourceId: "cli-member", jobId: x.job.jobId, generation: 1, contentHash: "hash", schemaVersion: 1, model: "model", promptVersion: "v1", payload });
    await x.db.update(researchSubjects).set({ currentProfileId: "current-profile" }).where(eq(researchSubjects.sourceId, "cli-member"));
    const destination = join(dirname(fileURLToPath(x.url)), "private-export.jsonl");
    const exported = x.cli("export", "cli-member", destination);
    expect(exported.status, exported.stderr).toBe(0);
    expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(payload);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(exported.stdout).not.toContain("private-profile-marker");
    expect(x.cli("status").stdout).not.toContain("private-profile-marker");
    await x.db.update(researchJobs).set({ status: "failed", phase: "complete" }).where(eq(researchJobs.jobId, x.job.jobId));
    expect(x.cli("retry", x.job.jobId).status).toBe(1);
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "cli-member", sourceRevision: 1, eventType: "delete", urls: [] }), 200);
    expect(x.cli("export", "cli-member", destination + ".json").status).toBe(1);
  });
});
