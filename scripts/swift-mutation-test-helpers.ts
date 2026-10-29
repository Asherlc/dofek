import { createHash } from "node:crypto";

export const toolchain = {
  toolVersion: "1.3.2",
  toolCommitSHA: "1e345263e36e1658adeed6ae919b7f5875a2601b",
  swiftSyntaxVersion: "604.0.0",
} as const;

export const requiredChecks = [
  "report.results",
  "plan.identity",
  "plan.mutationIDs",
  "source.anchors",
  "evidence.sourceAfter",
  "result.identity",
  "result.provenance",
  "evidence.sourceApplication",
  "evidence.activation",
  "evidence.buildProduct",
  "evidence.sourceDiff",
  "evidence.killAttribution",
  "integrity.recompute",
  "score.recompute",
  "archive.integrity",
  "archive.policy",
  "tierB.outcome",
];

export function hash(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function requiredItem<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required test fixture item is missing");
  return value;
}

export function mutationFixture(
  projectRoot = "/",
  sources: Record<string, string> = { "ios/Parser.swift": hash("// changed\n") },
) {
  const mutations = Object.entries(sources).map(([file, sourceFileHash], index) => ({
    id: `mut_${index}`,
    file,
    sourceFileHash,
    operatorID: "swift.core.bool-literal-inversion",
    operatorVersion: 1,
    originalText: "false",
    replacementText: "true",
    line: 1,
    column: 1,
    expectedSyntaxKind: "booleanLiteralExpr",
    occurrenceIndex: 0,
    prefixTokenFingerprint: "prefix",
    suffixTokenFingerprint: "suffix",
    utf8Range: { start: 0, end: 5 },
  }));
  const plan = {
    schemaVersion: 1 as const,
    planID: "plan_fixture",
    projectRoot,
    toolchain,
    sourceFileHashes: sources,
    mutations,
    skipped: [],
  };
  const count = mutations.length;
  const report = {
    schemaVersion: 2,
    planID: plan.planID,
    projectRoot,
    toolchain,
    baseline: { passed: true },
    results: mutations.map((point) => ({ point, outcome: "killedByAssertion" })),
    integrity: {
      discovered: count,
      planned: count,
      sourceApplied: count,
      buildObserved: count,
      buildFailures: 0,
      executed: count,
      classified: count,
      reported: count,
      explicitlySkipped: 0,
      skippedByReason: [],
      violations: [],
    },
    score: { killed: count, survived: 0, noCoverage: 0, excluded: {} },
    operationalIssues: [],
    evidenceArchive: { runID: "fixture-run", manifestHash: hash("manifest"), entryCount: count },
  };
  const verification = {
    schemaVersion: 1,
    planID: plan.planID,
    resultCount: count,
    planSupplied: true,
    passed: true,
    complete: false,
    tierAComplete: false,
    passCount: requiredChecks.length,
    failCount: 0,
    notVerifiableCount: 1,
    fullEvidenceReverified: true,
    tierBPerformed: true,
    checks: [
      ...requiredChecks.map((name) => ({ name, status: "pass" })),
      { name: "evidence.assertionConfirmation", status: "notVerifiable" },
    ],
    tierB: {
      reverifiedCount: count,
      matchedCount: count,
      mismatchedCount: 0,
      notVerifiableCount: 0,
      archiveProblemCount: 0,
    },
  };
  const trust = {
    schemaVersion: 1,
    planID: plan.planID,
    mutationCount: count,
    trustworthy: true,
    trustStatus: "trustworthy",
    operationalIssueCount: 0,
    verification: { unverifiedRequiredChecks: [] },
  };
  return { plan, report, verification, trust };
}
