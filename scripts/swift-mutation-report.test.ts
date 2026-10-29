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
    const { plan, verification, trust } = mutationFixture();
    expect(() => validateRunVerification(verification, plan)).not.toThrow();
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
    const { plan, verification } = mutationFixture();
    if (kind === "missing") verification.checks.shift();
    if (kind === "required unknown") requiredItem(verification.checks[0]).status = "notVerifiable";
    if (kind === "failed") requiredItem(verification.checks[0]).status = "fail";
    if (kind === "duplicate") verification.checks.push(requiredItem(verification.checks[0]));
    if (kind === "archive") verification.fullEvidenceReverified = false;
    if (kind === "mismatch") verification.tierB.mismatchedCount = 1;
    if (kind === "omission") verification.tierB.reverifiedCount = 0;
    if (kind === "counts") verification.passCount = 0;
    expect(() => validateRunVerification(verification, plan)).toThrow();
  });
  it("requires trust's mandatory-check verdict", () => {
    const { plan, trust } = mutationFixture();
    Reflect.set(trust.verification, "unverifiedRequiredChecks", ["plan.identity"]);
    expect(() => validateMutationTrust(trust, plan)).toThrow();
  });
});
