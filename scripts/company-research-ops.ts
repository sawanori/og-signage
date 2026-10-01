/** Private operator CLI. Never runs through the public signage application. */
import { createClient } from "@libsql/client";
import { writeFile } from "node:fs/promises";
import { eq, and, inArray, sql } from "drizzle-orm";
import { openResearchDatabase, researchWrite } from "../research/db/client";
import { researchControls, researchJobs, researchSubjects, researchProfiles, researchUsage, researchNow } from "../research/db/schema";
import { setResearchControl } from "../research/budget";

const [command = "help", ...args] = process.argv.slice(2);
const allowed = ["status", "usage", "export", "pause", "resume", "retry", "unblock-provider"];
if (!allowed.includes(command)) {
  console.log("research:ops status | usage | export <sourceId> <file.json|file.jsonl> | pause | resume | retry <jobId> | unblock-provider <meta|crawl>");
  process.exit(command === "help" ? 0 : 1);
}
class OperatorError extends Error {}
let connection: ReturnType<typeof openResearchDatabase> | undefined;
try {
  connection = openResearchDatabase({
    RESEARCH_DATABASE_URL: process.env.RESEARCH_DATABASE_URL,
    RESEARCH_AUTH_TOKEN: process.env.RESEARCH_AUTH_TOKEN,
  }, createClient);
  const { db } = connection;
  const now = researchNow();
  if (command === "status") {
    const jobs = await db.select({ jobId: researchJobs.jobId, sourceId: researchJobs.sourceId, phase: researchJobs.phase, status: researchJobs.status, attempts: researchJobs.attempts, nextRunAt: researchJobs.nextRunAt, lastErrorCode: researchJobs.lastErrorCode }).from(researchJobs).orderBy(sql`${researchJobs.createdAt} desc`).limit(50);
    const controls = await db.select().from(researchControls);
    console.log(JSON.stringify({ controls, jobs }, null, 2));
  } else if (command === "usage") {
    const usage = await db.select({ month: researchUsage.month, provider: researchUsage.provider, status: researchUsage.status, calls: sql<number>`count(*)`, chargedMicroUsd: sql<number>`sum(${researchUsage.chargedMicrousd})`, inputTokens: sql<number>`coalesce(sum(${researchUsage.inputTokens}),0)`, outputTokens: sql<number>`coalesce(sum(${researchUsage.outputTokens}),0)` }).from(researchUsage).groupBy(researchUsage.month, researchUsage.provider, researchUsage.status);
    console.log(JSON.stringify(usage, null, 2));
  } else if (command === "pause" || command === "resume") {
    await setResearchControl(db, "pause", { paused: command === "pause" }, now);
    console.log(command === "pause" ? "Paid research paused; intake and retention continue." : "Operational pause cleared; environment gates and budgets still apply.");
  } else if (command === "unblock-provider") {
    if (args.length !== 1 || !["meta", "crawl"].includes(args[0])) throw new OperatorError("Specify meta or crawl after repairing its credentials/configuration");
    await setResearchControl(db, `provider:${args[0]}`, { blocked: false }, now);
    console.log("Provider block cleared; retry individual jobs explicitly.");
  } else if (command === "retry") {
    if (args.length !== 1) throw new OperatorError("Exactly one jobId is required");
    await researchWrite(db, async (tx) => {
      const [job] = await tx.select().from(researchJobs).where(eq(researchJobs.jobId, args[0]));
      if (!job || !["failed", "configuration_required", "budget_exhausted"].includes(job.status)) throw new OperatorError("Only a stopped job can be retried");
      if (!["crawl", "extract"].includes(job.phase)) throw new OperatorError("A completed or purged job cannot be retried; save updated source URLs instead");
      const [subject] = await tx.select().from(researchSubjects).where(eq(researchSubjects.sourceId, job.sourceId));
      if (!subject || subject.status !== "active" || subject.currentJobId !== job.jobId) throw new OperatorError("A revoked or superseded job cannot be retried");
      // A deliberate manual run gets a fresh automatic-attempt window, not a fresh budget.
      await tx.update(researchJobs).set({ status: "retry", attempts: 0, progress: { ...job.progress, manualRetryToken: crypto.randomUUID() }, nextRunAt: now, leaseToken: null, leaseExpiresAt: null, updatedAt: now }).where(and(eq(researchJobs.jobId, job.jobId), inArray(researchJobs.status, ["failed", "configuration_required", "budget_exhausted"])));
    });
    console.log("One current job scheduled for retry; reservations and usage retained.");
  } else if (command === "export") {
    const [sourceId, destination] = args;
    if (args.length !== 2 || !/\.jsonl?$/.test(destination ?? "")) throw new OperatorError("Specify a sourceId and a .json or .jsonl output file");
    const [subject] = await db.select().from(researchSubjects).where(eq(researchSubjects.sourceId, sourceId));
    if (!subject || subject.status !== "active" || !subject.currentProfileId) throw new OperatorError("No active current profile exists");
    const [profile] = await db.select().from(researchProfiles).where(eq(researchProfiles.profileId, subject.currentProfileId));
    if (!profile) throw new OperatorError("Current profile is missing");
    await writeFile(destination, JSON.stringify(profile.payload, null, destination.endsWith(".jsonl") ? undefined : 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log("Current structured profile exported to the requested private file.");
  }
} catch (error) {
  // Drivers may include SQL arguments in errors. Do not print raw network/DB errors.
  console.error(error instanceof OperatorError ? error.message : "Research operation failed; inspect the job error code without logging secret values.");
  process.exitCode = 1;
} finally {
  connection?.close();
}
