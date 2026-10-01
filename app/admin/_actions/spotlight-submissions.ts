"use server";

import { AuthzError, requireRole, type AuthUser } from "../../../lib/auth";
import { getMediaBucket } from "../../../lib/r2";
import { getDb } from "../../../lib/runtime";
import { SpotlightSubmissionError, approveSpotlightSubmission, rejectSpotlightSubmission } from "../../../lib/services/spotlight-submissions";
import type { SpotlightSubmissionApproval, SpotlightSubmissionReview } from "../../../lib/spotlight-submissions";
import type { ActionResult } from "./content";

async function run<T>(fn: (user: AuthUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { data: await fn(await requireRole("staff")) };
  } catch (error) {
    if (error instanceof SpotlightSubmissionError) return { error: { code: error.code, message: error.message } };
    if (error instanceof AuthzError) return { error: { code: error.status === 401 ? "unauthorized" : "forbidden", message: error.status === 401 ? "ログインしてください" : "この操作を行う権限がありません" } };
    throw error;
  }
}

export async function approveSpotlightSubmissionAction(id: string, revision: number): Promise<ActionResult<SpotlightSubmissionApproval>> {
  return run((user) => approveSpotlightSubmission(getDb(), getMediaBucket(), user, id, revision));
}

export async function rejectSpotlightSubmissionAction(id: string, revision: number): Promise<ActionResult<SpotlightSubmissionReview>> {
  return run((user) => rejectSpotlightSubmission(getDb(), user, id, revision));
}
