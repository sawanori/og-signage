import { after } from "next/server";
import { env } from "cloudflare:workers";
import { getDb } from "../lib/runtime";
import { dispatchCompanyResearchEvents } from "./company-research-dispatch";

/** Call only after an authenticated mutation has committed successfully. */
export function scheduleCompanyResearchAfterSave(): void {
  if (!env.COMPANY_RESEARCH) return;
  try {
    // vinext connects function-form after() to response completion and ctx.waitUntil.
    after(async () => {
      try {
        const result = await dispatchCompanyResearchEvents(getDb(), env.COMPANY_RESEARCH, Math.floor(Date.now() / 1000), 5);
        console.log(`[after-save] research dispatch: delivered=${result.delivered} retried=${result.retried} blocked=${result.blocked} unavailable=${result.unavailable}`);
      } catch {
        console.error("[after-save] Research delivery failed; the durable outbox remains available for retry");
      }
    });
  } catch {
    // A scheduling/runtime failure must not turn an already-committed save into an error.
    console.error("[after-save] Research scheduling unavailable; the durable outbox remains available for retry");
  }
}
