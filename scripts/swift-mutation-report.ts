import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { mutantKitIdentity } from "./swift-mutation-tool.ts";

const count = z.number().int().nonnegative();
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const toolchain = z
  .object({
    toolVersion: z.literal(mutantKitIdentity.toolVersion),
    toolCommitSHA: z.literal(mutantKitIdentity.toolCommitSHA),
    swiftSyntaxVersion: z.literal(mutantKitIdentity.swiftSyntaxVersion),
  })
  .passthrough();
const point = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1),
    sourceFileHash: hash,
    operatorID: z.string().min(1),
    operatorVersion: z.number().int().positive(),
    originalText: z.string().min(1),
    replacementText: z.string(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    expectedSyntaxKind: z.string().min(1),
    occurrenceIndex: count,
    prefixTokenFingerprint: z.string(),
    suffixTokenFingerprint: z.string(),
    utf8Range: z
      .object({ start: count, end: z.number().int().positive() })
      .refine((range) => range.end > range.start),
  })
  .passthrough();
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    planID: z.string().min(1),
    projectRoot: z.string().min(1),
    toolchain,
    sourceFileHashes: z.record(z.string(), hash),
    mutations: z.array(point),
    operators: z.array(
      z.object({ id: z.string(), version: z.number(), defaultEnabled: z.boolean() }).passthrough(),
    ),
    skipped: z
      .array(z.unknown())
      .max(0, "Skipped, budgeted or suppressed mutations are not allowed"),
  })
  .passthrough();
type Plan = z.infer<typeof planSchema>;
const outcome = z.enum([
  "killedByAssertion",
  "killedByCrash",
  "verifiedTimeout",
  "survived",
  "noCoverage",
  "unviable",
  "timedOut",
  "flaky",
  "notApplied",
  "baselineMismatch",
  "infrastructureFailure",
  "notMaterialized",
  "skipped",
]);
const reportSchema = z
  .object({
    schemaVersion: z.literal(2),
    planID: z.string(),
    projectRoot: z.string(),
    toolchain,
    baseline: z.object({ passed: z.literal(true) }).passthrough(),
    results: z.array(
      z
        .object({
          point,
          outcome,
          evidence: z
            .object({
              confirmationChain: z.array(z.unknown()).optional(),
              crashConfirmation: z.object({ crashedAgain: z.boolean() }).passthrough().optional(),
              timeoutConfirmation: z
                .object({ timedOutAgain: z.boolean() })
                .passthrough()
                .optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
    integrity: z
      .object({
        discovered: count,
        planned: count,
        sourceApplied: count,
        buildObserved: count,
        buildFailures: count,
        executed: count,
        classified: count,
        reported: count,
        explicitlySkipped: z.literal(0),
        skippedByReason: z.array(z.unknown()).max(0),
        violations: z.array(z.unknown()).max(0),
      })
      .passthrough(),
    score: z.object({
      killed: count,
      survived: count,
      noCoverage: count,
      excluded: z.record(z.string(), count),
    }),
    operationalIssues: z.array(z.unknown()).max(0),
    evidenceArchive: z.object({
      runID: z.string().regex(/^[a-zA-Z0-9-]+$/),
      manifestHash: hash,
      entryCount: count,
    }),
  })
  .passthrough();
type Report = z.infer<typeof reportSchema>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameMembers(actual: string[], expected: string[], context: string): void {
  requireCondition(
    new Set(actual).size === actual.length &&
      isDeepStrictEqual([...actual].sort(), [...expected].sort()),
    `Incomplete or duplicate ${context}`,
  );
}

export function validateMutationPlan(
  value: unknown,
  expected: { projectRoot: string; sources: Record<string, string> },
): Plan {
  const plan = planSchema.parse(value);
  requireCondition(Object.keys(expected.sources).length > 0, "No requested compiled source files");
  requireCondition(
    realpathSync(plan.projectRoot) === realpathSync(expected.projectRoot),
    "Mutation plan project root mismatch",
  );
  sameMembers(
    Object.keys(plan.sourceFileHashes),
    Object.keys(expected.sources),
    "requested source inventory",
  );
  for (const [file, expectedHash] of Object.entries(expected.sources)) {
    requireCondition(
      plan.sourceFileHashes[file] === expectedHash,
      `Stale mutation plan hash for ${file}`,
    );
  }
  if (plan.mutations.length === 0) {
    sameMembers(
      plan.operators.map((operator) => operator.id),
      [
        "swift.core.bool-literal-inversion",
        "swift.core.logical-connector-replacement",
        "swift.core.relational-operator-replacement",
        "swift.core.return-value-replacement",
        "swift.core.ternary-branch-swap",
        "swift.core.unary-not-removal",
      ],
      "zero-candidate default operators",
    );
    requireCondition(
      plan.operators.every((operator) => operator.version === 1 && operator.defaultEnabled),
      "Incomplete zero-candidate operator catalogue",
    );
  }
  const ids = plan.mutations.map((mutation) => mutation.id);
  requireCondition(new Set(ids).size === ids.length, "Duplicate mutation plan IDs");
  for (const mutation of plan.mutations) {
    requireCondition(
      mutation.sourceFileHash === expected.sources[mutation.file],
      `Unexpected mutation source/hash for ${mutation.file}`,
    );
  }
  return plan;
}

export function validateMutationReport(value: unknown, plan: Plan) {
  const report = reportSchema.parse(value);
  requireCondition(
    report.planID === plan.planID &&
      realpathSync(report.projectRoot) === realpathSync(plan.projectRoot),
    "Mutation report plan/project mismatch",
  );
  requireCondition(
    isDeepStrictEqual(report.toolchain, plan.toolchain),
    "Mutation report toolchain mismatch",
  );
  sameMembers(
    report.results.map((result) => result.point.id),
    plan.mutations.map((mutation) => mutation.id),
    "plan/result IDs",
  );
  const planned = new Map(plan.mutations.map((mutation) => [mutation.id, mutation]));
  const tally: Record<string, number> = {};
  for (const result of report.results) {
    requireCondition(
      isDeepStrictEqual(result.point, planned.get(result.point.id)),
      `Result point/anchor mismatch: ${result.point.id}`,
    );
    requireCondition(
      !["notApplied", "baselineMismatch", "infrastructureFailure", "skipped"].includes(
        result.outcome,
      ),
      `Unusable mutation outcome ${result.outcome}: ${result.point.id}`,
    );
    tally[result.outcome] = (tally[result.outcome] ?? 0) + 1;
  }
  const mutationCount = plan.mutations.length;
  if (mutationCount === 0) {
    z.object({
      passed: z.literal(true),
      buildProductHash: hash,
      buildCommand: z.object({ exitCode: z.literal(0) }),
      testCommand: z.object({ exitCode: z.literal(0) }),
      buildDurationSeconds: z.number().finite().positive(),
      testDurationSeconds: z.number().finite().positive(),
    }).parse(report.baseline);
  }
  const counters = report.integrity;
  for (const name of [
    "discovered",
    "planned",
    "sourceApplied",
    "classified",
    "reported",
  ] as const) {
    requireCondition(
      counters[name] === mutationCount,
      `Invalid mutation integrity counter ${name}: ${counters[name]}, expected ${mutationCount}`,
    );
  }
  requireCondition(
    counters.buildObserved <= mutationCount &&
      counters.buildFailures <= mutationCount &&
      counters.buildObserved + counters.buildFailures === mutationCount &&
      counters.buildFailures === (tally.unviable ?? 0) &&
      counters.executed <= counters.buildObserved,
    "Invalid mutation build/execution counters",
  );
  const killed =
    (tally.killedByAssertion ?? 0) + (tally.killedByCrash ?? 0) + (tally.verifiedTimeout ?? 0);
  const survived = tally.survived ?? 0;
  const noCoverage = tally.noCoverage ?? 0;
  const executed = report.results.filter(
    (result) =>
      result.testSummary !== undefined ||
      [
        "killedByAssertion",
        "killedByCrash",
        "verifiedTimeout",
        "survived",
        "timedOut",
        "flaky",
      ].includes(result.outcome),
  ).length;
  requireCondition(
    counters.executed === executed,
    "Mutation execution counter does not reconcile with results",
  );
  const excluded = Object.fromEntries(
    Object.entries(tally).filter(
      ([name]) =>
        ![
          "killedByAssertion",
          "killedByCrash",
          "verifiedTimeout",
          "survived",
          "noCoverage",
        ].includes(name),
    ),
  );
  requireCondition(
    isDeepStrictEqual(report.score, { killed, survived, noCoverage, excluded }),
    "Mutation score/outcome counts do not reconcile",
  );
  requireCondition(
    mutationCount === 0 || (killed + survived > 0 && Number.isFinite(killed / (killed + survived))),
    "No finite positive measured mutation denominator",
  );
  requireCondition(
    report.evidenceArchive.entryCount === mutationCount,
    "Incomplete mutation evidence archive",
  );
  return report;
}

export function validatePlanVerification(value: unknown, plan: Plan): void {
  z.object({
    schemaVersion: z.literal(1),
    planID: z.literal(plan.planID),
    mutationCount: z.literal(plan.mutations.length),
    valid: z.literal(true),
    compatibility: z.literal("match"),
    idViolations: z.array(z.unknown()).max(0),
    missingFiles: z.array(z.unknown()).max(0),
    anchorViolations: z.array(z.unknown()).max(0),
  }).parse(value);
}

const requiredChecks = [
  "report.results",
  "plan.identity",
  "plan.mutationIDs",
  "source.anchors",
  "evidence.sourceAfter",
  "result.identity",
  "result.provenance",
  "evidence.sourceApplication",
  "evidence.sourceDiff",
  "integrity.recompute",
  "score.recompute",
  "archive.integrity",
  "archive.policy",
  "tierB.outcome",
];

export function validateRunVerification(value: unknown, plan: Plan, report: Report): void {
  if (plan.mutations.length === 0) {
    const verified = z
      .object({
        schemaVersion: z.literal(1),
        planID: z.literal(plan.planID),
        resultCount: z.literal(0),
        planSupplied: z.literal(true),
      })
      .passthrough()
      .parse(value);
    validateZeroCandidateVerification(verified, ["source.anchors", "evidence.sourceAfter"]);
    return;
  }
  const verified = z
    .object({
      schemaVersion: z.literal(1),
      planID: z.literal(plan.planID),
      resultCount: z.literal(plan.mutations.length),
      planSupplied: z.literal(true),
      passed: z.literal(true),
      fullEvidenceReverified: z.literal(true),
      tierBPerformed: z.literal(true),
      passCount: count,
      failCount: z.literal(0),
      notVerifiableCount: count,
      checks: z.array(
        z.object({ name: z.string(), status: z.enum(["pass", "fail", "notVerifiable"]) }),
      ),
      tierB: z.object({
        reverifiedCount: z.literal(plan.mutations.length),
        matchedCount: z.literal(plan.mutations.length),
        mismatchedCount: z.literal(0),
        notVerifiableCount: z.literal(0),
        archiveProblemCount: z.literal(0),
      }),
    })
    .parse(value);
  const checks = new Map(verified.checks.map((check) => [check.name, check.status]));
  requireCondition(
    checks.size === verified.checks.length,
    "Duplicate official verification checks",
  );
  const applicableChecks = new Set(requiredChecks);
  const hasAssertionKill = report.results.some((result) => result.outcome === "killedByAssertion");
  for (const result of report.results) {
    if (["killedByAssertion", "killedByCrash", "survived"].includes(result.outcome)) {
      applicableChecks.add("evidence.activation");
      applicableChecks.add("evidence.buildProduct");
    }
    if (result.outcome === "killedByAssertion") applicableChecks.add("evidence.killAttribution");
    if (result.outcome === "killedByCrash") applicableChecks.add("evidence.crashConfirmation");
    if (result.outcome === "verifiedTimeout") applicableChecks.add("evidence.timeoutConfirmation");
    if (
      result.outcome === "killedByCrash" ||
      result.outcome === "verifiedTimeout" ||
      (result.evidence?.confirmationChain?.length ?? 0) > 0 ||
      result.evidence?.crashConfirmation ||
      result.evidence?.timeoutConfirmation
    )
      applicableChecks.add("evidence.confirmationChain");
  }
  for (const name of applicableChecks)
    requireCondition(
      checks.get(name) === "pass",
      `Required mutation verification check did not pass: ${name}`,
    );
  for (const check of verified.checks)
    requireCondition(
      check.status === "pass" ||
        (hasAssertionKill &&
          check.name === "evidence.assertionConfirmation" &&
          check.status === "notVerifiable"),
      `Unverified mutation evidence: ${check.name}`,
    );
  requireCondition(
    verified.passCount === verified.checks.filter((check) => check.status === "pass").length &&
      verified.notVerifiableCount ===
        verified.checks.filter((check) => check.status === "notVerifiable").length,
    "Invalid official verification counters",
  );
}

export function validateMutationTrust(value: unknown, plan: Plan): void {
  if (plan.mutations.length === 0) {
    const trust = z
      .object({
        schemaVersion: z.literal(1),
        planID: z.literal(plan.planID),
        mutationCount: z.literal(0),
        trustworthy: z.literal(false),
        trustStatus: z.literal("mismatch"),
        operationalIssueCount: z.literal(0),
        integrity: z.object({
          passed: z.literal(true),
          violationCount: z.literal(0),
          violations: z.array(z.unknown()).max(0),
        }),
        verification: z
          .object({
            planSupplied: z.literal(true),
            unverifiedRequiredChecks: z.array(z.string()),
          })
          .passthrough(),
      })
      .parse(value);
    sameMembers(
      trust.verification.unverifiedRequiredChecks,
      ["report.results", "result.identity", "result.provenance"],
      "zero-candidate unverified requirements",
    );
    validateZeroCandidateVerification(trust.verification, []);
    return;
  }
  z.object({
    schemaVersion: z.literal(1),
    planID: z.literal(plan.planID),
    mutationCount: z.literal(plan.mutations.length),
    trustworthy: z.literal(true),
    trustStatus: z.literal("trustworthy"),
    operationalIssueCount: z.literal(0),
    verification: z.object({ unverifiedRequiredChecks: z.array(z.string()).max(0) }),
  }).parse(value);
}

/** Preserve MutantKit's no-result verdict while validating every applicable check. */
function validateZeroCandidateVerification(value: unknown, sourceChecks: string[]): void {
  const verification = z
    .object({
      passed: z.literal(false),
      complete: z.literal(false),
      tierAComplete: z.literal(false),
      fullEvidenceReverified: z.literal(false),
      tierBPerformed: z.literal(false),
      failCount: z.literal(1),
      notVerifiableCount: z.literal(0),
      passCount: count,
      checks: z.array(
        z.object({ name: z.string(), status: z.enum(["pass", "fail", "notVerifiable"]) }),
      ),
    })
    .parse(value);
  const passed = [
    "plan.identity",
    "plan.mutationIDs",
    "integrity.recompute",
    "score.recompute",
    "archive.integrity",
    "archive.policy",
    ...sourceChecks,
  ];
  sameMembers(
    verification.checks.map((check) => check.name),
    ["report.results", ...passed],
    "zero-candidate verification checks",
  );
  requireCondition(
    verification.passCount === passed.length,
    "Invalid zero-candidate verification counters",
  );
  for (const check of verification.checks) {
    requireCondition(
      check.status === (check.name === "report.results" ? "fail" : "pass"),
      `Unexpected zero-candidate verification result: ${check.name}`,
    );
  }
}
