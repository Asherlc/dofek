import { describe, expect, it } from "vitest";
import {
  validateMutationPlan,
  validateMutationReport,
  validateMutationTrust,
  validatePlanVerification,
  validateRunVerification,
} from "./swift-mutation-report.ts";
import { mutationFixture, requiredItem } from "./swift-mutation-test-helpers.ts";

describe("Swift mutation plan boundary", () => {
  it("accepts exact requested hashes and positive work", () => {
    const { plan } = mutationFixture();
    expect(
      validateMutationPlan(plan, { projectRoot: "/", sources: plan.sourceFileHashes }),
    ).toEqual(plan);
  });
  it.each(["missing", "extra", "hash", "zero", "duplicate", "skipped", "tool", "root", "anchor"])(
    "rejects %s plan work",
    (kind) => {
      const { plan } = mutationFixture();
      const sources = { ...plan.sourceFileHashes };
      if (kind === "missing") delete Reflect.get(plan, "sourceFileHashes")["ios/Parser.swift"];
      if (kind === "extra")
        Reflect.set(plan.sourceFileHashes, "Extra.swift", sources["ios/Parser.swift"]);
      if (kind === "hash") plan.sourceFileHashes["ios/Parser.swift"] = `sha256:${"0".repeat(64)}`;
      if (kind === "zero") plan.mutations = [];
      if (kind === "duplicate") plan.mutations.push(requiredItem(plan.mutations[0]));
      if (kind === "skipped")
        Reflect.set(plan, "skipped", [{ id: "hidden", reason: "budgetExceeded" }]);
      if (kind === "tool")
        Reflect.set(plan, "toolchain", { ...plan.toolchain, toolVersion: "1.3.1" });
      if (kind === "root") plan.projectRoot = "/usr";
      if (kind === "anchor")
        requiredItem(plan.mutations[0]).sourceFileHash = `sha256:${"1".repeat(64)}`;
      expect(() => validateMutationPlan(plan, { projectRoot: "/", sources })).toThrow();
    },
  );
  it("requires official current anchor verification and compatibility", () => {
    const { plan } = mutationFixture();
    const valid = {
      schemaVersion: 1,
      planID: plan.planID,
      mutationCount: 1,
      valid: true,
      compatibility: "match",
      idViolations: [],
      missingFiles: [],
      anchorViolations: [],
    };
    expect(() => validatePlanVerification(valid, plan)).not.toThrow();
    for (const change of [
      { valid: false },
      { compatibility: "mismatch" },
      { anchorViolations: [{}] },
      { mutationCount: 0 },
    ]) {
      expect(() => validatePlanVerification({ ...valid, ...change }, plan)).toThrow();
    }
  });
});

describe("Swift mutation report boundary", () => {
  it("accepts a measured survivor without imposing a threshold", () => {
    const { plan, report } = mutationFixture();
    requiredItem(report.results[0]).outcome = "survived";
    report.score = { killed: 0, survived: 1, noCoverage: 0, excluded: {} };
    expect(validateMutationReport(report, plan).score?.survived).toBe(1);
  });
  it("preserves distinct kills, compile exclusions and indeterminate outcomes", () => {
    const { plan, report } = mutationFixture(
      "/",
      Object.fromEntries(
        [
          "killedByAssertion",
          "killedByCrash",
          "verifiedTimeout",
          "survived",
          "unviable",
          "timedOut",
          "flaky",
          "notMaterialized",
          "noCoverage",
        ].map((_, index) => [`${index}.swift`, `sha256:${"0".repeat(64)}`]),
      ),
    );
    const outcomes = [
      "killedByAssertion",
      "killedByCrash",
      "verifiedTimeout",
      "survived",
      "unviable",
      "timedOut",
      "flaky",
      "notMaterialized",
      "noCoverage",
    ];
    report.results.forEach((result, index) => {
      result.outcome = requiredItem(outcomes[index]);
    });
    report.score = {
      killed: 3,
      survived: 1,
      noCoverage: 1,
      excluded: { unviable: 1, timedOut: 1, flaky: 1, notMaterialized: 1 },
    };
    report.integrity.buildFailures = 1;
    report.integrity.buildObserved = 8;
    report.integrity.executed = 6;
    expect(validateMutationReport(report, plan).results.map((result) => result.outcome)).toEqual(
      outcomes,
    );
  });
  it.each([
    "schema",
    "baseline",
    "missing",
    "duplicate",
    "extra",
    "point",
    "counter",
    "builds",
    "compile count",
    "execution count",
    "negative",
    "fraction",
    "score",
    "zero",
    "operational",
    "infrastructure",
    "skipped",
    "archive",
  ])("rejects %s report corruption", (kind) => {
    const { plan, report } = mutationFixture();
    if (kind === "schema") report.schemaVersion = 1;
    if (kind === "baseline") report.baseline.passed = false;
    if (kind === "missing") report.results = [];
    if (kind === "duplicate") report.results.push(requiredItem(report.results[0]));
    if (kind === "extra")
      report.results = [
        {
          ...requiredItem(report.results[0]),
          point: { ...requiredItem(report.results[0]).point, id: "extra" },
        },
      ];
    if (kind === "point")
      report.results = [
        {
          ...requiredItem(report.results[0]),
          point: { ...requiredItem(report.results[0]).point, originalText: "altered" },
        },
      ];
    if (kind === "counter") report.integrity.reported = 0;
    if (kind === "builds") {
      report.integrity.buildObserved = 0;
      report.integrity.executed = 0;
    }
    if (kind === "compile count") {
      report.integrity.buildFailures = 1;
      report.integrity.buildObserved = 0;
      report.integrity.executed = 0;
    }
    if (kind === "execution count") report.integrity.executed = 0;
    if (kind === "negative") report.integrity.buildFailures = -1;
    if (kind === "fraction") report.integrity.executed = 0.5;
    if (kind === "score") report.score.killed = 9;
    if (kind === "zero") {
      requiredItem(report.results[0]).outcome = "unviable";
      report.score = { killed: 0, survived: 0, noCoverage: 0, excluded: { unviable: 1 } };
    }
    if (kind === "operational")
      Reflect.set(report, "operationalIssues", [{ diagnosis: "disk full" }]);
    if (kind === "infrastructure")
      requiredItem(report.results[0]).outcome = "infrastructureFailure";
    if (kind === "skipped") report.integrity.explicitlySkipped = 1;
    if (kind === "archive") report.evidenceArchive.entryCount = 0;
    expect(() => validateMutationReport(report, plan)).toThrow();
  });
});

describe("official evidence acceptance", () => {
  it("accepts optional unknown assertion confirmation with complete raw re-derivation", () => {
    const { plan, report, verification, trust } = mutationFixture();
    expect(() =>
      validateRunVerification(verification, plan, validateMutationReport(report, plan)),
    ).not.toThrow();
    expect(() => validateMutationTrust(trust, plan)).not.toThrow();
  });
  it.each([
    "missing",
    "required unknown",
    "failed",
    "duplicate",
    "archive",
    "mismatch",
    "omission",
    "counts",
  ])("rejects %s verification even when passed is true", (kind) => {
    const { plan, report, verification } = mutationFixture();
    if (kind === "missing") {
      verification.checks.shift();
      verification.passCount -= 1;
    }
    if (kind === "required unknown") requiredItem(verification.checks[0]).status = "notVerifiable";
    if (kind === "failed") requiredItem(verification.checks[0]).status = "fail";
    if (kind === "duplicate") verification.checks.push(requiredItem(verification.checks[0]));
    if (kind === "archive") verification.fullEvidenceReverified = false;
    if (kind === "mismatch") verification.tierB.mismatchedCount = 1;
    if (kind === "omission") verification.tierB.reverifiedCount = 0;
    if (kind === "counts") verification.passCount = 0;
    expect(() =>
      validateRunVerification(verification, plan, validateMutationReport(report, plan)),
    ).toThrow();
  });
  it("requires trust's mandatory-check verdict", () => {
    const { plan, trust } = mutationFixture();
    Reflect.set(trust.verification, "unverifiedRequiredChecks", ["plan.identity"]);
    expect(() => validateMutationTrust(trust, plan)).toThrow();
  });
});

// The two captured CI subsets come from b06 artifacts12912061956 and12912616786.
// Plan identities are normalized to the local boundary fixture; check membership is retained.
function outcomeVerificationFixture(
  outcome: "killedByAssertion" | "killedByCrash" | "verifiedTimeout" | "survived",
) {
  const fixture = mutationFixture();
  const result = requiredItem(fixture.report.results[0]);
  result.outcome = outcome;
  const checks = fixture.verification.checks;
  if (outcome !== "killedByAssertion") {
    fixture.verification.checks = checks.filter(
      (check) =>
        !["evidence.killAttribution", "evidence.assertionConfirmation"].includes(check.name),
    );
  }
  if (outcome === "killedByCrash" || outcome === "verifiedTimeout") {
    fixture.verification.checks.push(
      {
        name:
          outcome === "killedByCrash"
            ? "evidence.crashConfirmation"
            : "evidence.timeoutConfirmation",
        status: "pass",
      },
      { name: "evidence.confirmationChain", status: "pass" },
    );
    Reflect.set(result, "evidence", {
      confirmationChain: [{ kind: outcome === "killedByCrash" ? "crash" : "timeout" }],
      ...(outcome === "killedByCrash"
        ? { crashConfirmation: { crashedAgain: true } }
        : { timeoutConfirmation: { timedOutAgain: true } }),
    });
  }
  if (outcome === "verifiedTimeout")
    fixture.verification.checks = fixture.verification.checks.filter(
      (check) => !["evidence.activation", "evidence.buildProduct"].includes(check.name),
    );
  if (outcome === "survived")
    fixture.report.score = { killed: 0, survived: 1, noCoverage: 0, excluded: {} };
  fixture.verification.passCount = fixture.verification.checks.filter(
    (check) => check.status === "pass",
  ).length;
  fixture.verification.notVerifiableCount = fixture.verification.checks.filter(
    (check) => check.status === "notVerifiable",
  ).length;
  return fixture;
}

describe("outcome-specific official verification", () => {
  it("accepts the real crash-only18-pass subset without assertion attribution", () => {
    const { plan, report, verification } = outcomeVerificationFixture("killedByCrash");
    expect(verification.passCount).toBe(18);
    expect(() =>
      validateRunVerification(verification, plan, validateMutationReport(report, plan)),
    ).not.toThrow();
  });
  it("accepts the real assertion-only subset without crash or chain findings", () => {
    const { plan, report, verification } = outcomeVerificationFixture("killedByAssertion");
    expect(verification.passCount).toBe(17);
    expect(verification.notVerifiableCount).toBe(1);
    expect(() =>
      validateRunVerification(verification, plan, validateMutationReport(report, plan)),
    ).not.toThrow();
  });
  it.each(["verifiedTimeout", "survived"] as const)(
    "accepts the pinned verifier's %s subset",
    (outcome) => {
      const { plan, report, verification } = outcomeVerificationFixture(outcome);
      expect(() =>
        validateRunVerification(verification, plan, validateMutationReport(report, plan)),
      ).not.toThrow();
    },
  );
  it.each([
    ["killedByAssertion", "evidence.killAttribution"],
    ["killedByCrash", "evidence.crashConfirmation"],
    ["killedByCrash", "evidence.confirmationChain"],
    ["verifiedTimeout", "evidence.timeoutConfirmation"],
    ["verifiedTimeout", "evidence.confirmationChain"],
    ["killedByAssertion", "evidence.activation"],
    ["survived", "evidence.activation"],
    ["survived", "evidence.buildProduct"],
  ] as const)("requires applicable %s check %s", (outcome, name) => {
    for (const status of ["missing", "fail", "notVerifiable", "unknown"]) {
      const { plan, report, verification } = outcomeVerificationFixture(outcome);
      if (status === "missing")
        verification.checks = verification.checks.filter((check) => check.name !== name);
      else requiredItem(verification.checks.find((check) => check.name === name)).status = status;
      verification.passCount = verification.checks.filter(
        (check) => check.status === "pass",
      ).length;
      verification.notVerifiableCount = verification.checks.filter(
        (check) => check.status === "notVerifiable",
      ).length;
      expect(() =>
        validateRunVerification(verification, plan, validateMutationReport(report, plan)),
      ).toThrow();
    }
  });
  it.each(["killedByAssertion", "killedByCrash", "verifiedTimeout", "survived"] as const)(
    "retains universal/source/archive requirements for %s",
    (outcome) => {
      for (const name of [
        "report.results",
        "source.anchors",
        "archive.integrity",
        "archive.policy",
        "tierB.outcome",
      ]) {
        const { plan, report, verification } = outcomeVerificationFixture(outcome);
        verification.checks = verification.checks.filter((check) => check.name !== name);
        verification.passCount -= 1;
        expect(() =>
          validateRunVerification(verification, plan, validateMutationReport(report, plan)),
        ).toThrow();
      }
    },
  );
  it("retains Types' three nonmaterialized exclusions and one measured kill", () => {
    const { verification } = outcomeVerificationFixture("killedByAssertion");
    const { plan, report } = mutationFixture(
      "/",
      Object.fromEntries(
        [0, 1, 2, 3].map((index) => [`${index}.swift`, `sha256:${"0".repeat(64)}`]),
      ),
    );
    report.results.forEach((result, index) => {
      result.outcome = index === 0 ? "killedByAssertion" : "notMaterialized";
    });
    report.integrity.executed = 1;
    report.score = { killed: 1, survived: 0, noCoverage: 0, excluded: { notMaterialized: 3 } };
    verification.resultCount = 4;
    verification.tierB.reverifiedCount = 4;
    verification.tierB.matchedCount = 4;
    const validated = validateMutationReport(report, plan);
    expect(validated.score).toEqual({
      killed: 1,
      survived: 0,
      noCoverage: 0,
      excluded: { notMaterialized: 3 },
    });
    expect(() => validateRunVerification(verification, plan, validated)).not.toThrow();
  });
  it("does not score an entirely nonmaterialized campaign as measured work", () => {
    const { plan, report } = mutationFixture();
    requiredItem(report.results[0]).outcome = "notMaterialized";
    report.integrity.executed = 0;
    report.score = { killed: 0, survived: 0, noCoverage: 0, excluded: { notMaterialized: 1 } };
    expect(() => validateMutationReport(report, plan)).toThrow(/positive measured/);
  });
  it("requires a recorded confirmation chain on an indeterminate result", () => {
    const { plan, report, verification } = mutationFixture("/", {
      "first.swift": `sha256:${"0".repeat(64)}`,
      "second.swift": `sha256:${"1".repeat(64)}`,
    });
    const result = requiredItem(report.results[1]);
    result.outcome = "flaky";
    Reflect.set(result, "evidence", { confirmationChain: [{ kind: "crash" }] });
    report.score = { killed: 1, survived: 0, noCoverage: 0, excluded: { flaky: 1 } };
    const validated = validateMutationReport(report, plan);
    expect(() => validateRunVerification(verification, plan, validated)).toThrow(
      /confirmationChain/,
    );
    verification.checks.push({ name: "evidence.confirmationChain", status: "pass" });
    verification.passCount += 1;
    expect(() => validateRunVerification(verification, plan, validated)).not.toThrow();
  });
  it("does not waive an unknown assertion-confirmation check on a crash-only report", () => {
    const { plan, report, verification } = outcomeVerificationFixture("killedByCrash");
    verification.checks.push({ name: "evidence.assertionConfirmation", status: "notVerifiable" });
    verification.notVerifiableCount += 1;
    expect(() =>
      validateRunVerification(verification, plan, validateMutationReport(report, plan)),
    ).toThrow(/Unverified/);
  });
});
