import type { EvidencePage, ProfileContent, ResearchClaim } from "./profile-schema";

export class EvidenceError extends Error {
  readonly code = "invalid_evidence";
  constructor(
    readonly reason: "duplicate_source" | "unknown_source" | "quote_not_found" | "inferred_limitation" | "empty_evidence",
    readonly claimIndex: number,
  ) { super("Extracted claims do not match the supplied sources"); }
}

export function profileClaims(profile: ProfileContent): ResearchClaim[] {
  return [
    profile.company.name, profile.company.summary,
    ...profile.company.industries, ...profile.company.regions,
    ...profile.services.flatMap((service) => [
      service.name, service.description, ...service.targetCustomers,
      ...service.problemsSolved, ...service.delivery, ...service.pricing,
    ]),
    ...profile.strengths, ...profile.limitations, ...profile.sourceConflicts,
  ].filter((claim): claim is ResearchClaim => claim !== null);
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function validateEvidence(profile: ProfileContent, pages: EvidencePage[]): void {
  const sources = new Map(pages.map((page) => [page.sourceId, normalized(page.markdown)]));
  for (const [index, claim] of profileClaims(profile).entries()) {
    if (new Set(claim.sourceIds).size !== claim.sourceIds.length) throw new EvidenceError("duplicate_source", index);
    const evidence = normalized(claim.evidenceText);
    if (!/[\p{L}\p{N}]/u.test(evidence)) throw new EvidenceError("empty_evidence", index);
    // Every cited page must support the quoted passage; fabricated IDs never pass.
    if (claim.sourceIds.some((id) => !sources.has(id))) throw new EvidenceError("unknown_source", index);
    if (!claim.sourceIds.every((id) => sources.get(id)!.includes(evidence))) throw new EvidenceError("quote_not_found", index);
  }
  // A missing price or statement is unknown, not proof of a business weakness.
  const inferredLimitation = profile.limitations.findIndex((claim) => claim.kind === "inference");
  if (inferredLimitation >= 0) throw new EvidenceError("inferred_limitation", inferredLimitation);
}
