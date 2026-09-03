import { describe, expect, it } from "vitest";
import { parseActivityDataIntegrityCommand } from "./repair-activity-data-integrity.ts";

const repairBounds = [
  "--user-id=00000000-0000-4000-8000-000000000001",
  "--start-at=2026-09-01T00:00:00Z",
  "--end-at=2026-09-02T00:00:00+00:00",
];

describe("parseActivityDataIntegrityCommand", () => {
  it("defaults to a bounded dry run in an explicit user-scoped UTC window", () => {
    expect(parseActivityDataIntegrityCommand(repairBounds)).toEqual({
      kind: "repair",
      options: {
        userId: "00000000-0000-4000-8000-000000000001",
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-02T00:00:00.000Z"),
        execute: false,
        batchSize: 250,
        maxBatches: 20,
      },
    });
  });

  it("requires a named acceptance owner and future deadline for execute mode", () => {
    expect(
      parseActivityDataIntegrityCommand(
        [
          ...repairBounds,
          "--execute",
          "--batch-size=25",
          "--max-batches=4",
          "--acceptance-owner=data-on-call@example.com",
          "--acceptance-deadline=2026-09-03T00:00:00Z",
          "--artifact-directory=/secure/audits",
        ],
        new Date("2026-09-02T00:00:00Z"),
      ),
    ).toEqual({
      kind: "repair",
      options: {
        userId: "00000000-0000-4000-8000-000000000001",
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-02T00:00:00.000Z"),
        execute: true,
        batchSize: 25,
        maxBatches: 4,
        acceptanceOwner: "data-on-call@example.com",
        acceptanceDeadline: new Date("2026-09-03T00:00:00.000Z"),
        artifactDirectory: "/secure/audits",
      },
    });
  });

  it("parses rollback and retirement as explicit artifact operations", () => {
    expect(
      parseActivityDataIntegrityCommand(["--rollback-artifact=/secure/run.audit.json"]),
    ).toEqual({
      kind: "rollback",
      artifactPath: "/secure/run.audit.json",
    });
    expect(
      parseActivityDataIntegrityCommand([
        "--retire-artifact=/secure/run.audit.json",
        "--accepted-by=data-on-call@example.com",
        "--disposition=accepted",
      ]),
    ).toEqual({
      kind: "retire",
      artifactPath: "/secure/run.audit.json",
      acceptedBy: "data-on-call@example.com",
      disposition: "accepted",
    });
  });

  it.each([
    { args: repairBounds.slice(1), message: "--user-id is required" },
    {
      args: [repairBounds[0], "--start-at=2026-09-01", repairBounds[2]],
      message: "--start-at must use UTC",
    },
    {
      args: [repairBounds[0], "--start-at=2026-09-01T00:00:00-07:00", repairBounds[2]],
      message: "--start-at must use UTC",
    },
    {
      args: [...repairBounds, "--execute"],
      message: "--acceptance-owner is required with --execute",
    },
    {
      args: [...repairBounds, "--batch-size=0"],
      message: "--batch-size",
    },
    {
      args: [
        ...repairBounds,
        "--execute",
        "--acceptance-owner=data-on-call@example.com",
        "--acceptance-deadline=2026-09-04T00:00:00.001Z",
      ],
      message: "within 24 hours",
    },
    {
      args: ["--rollback-artifact=/tmp/a", ...repairBounds],
      message: "cannot be combined",
    },
  ])("rejects unsafe command input", ({ args, message }) => {
    expect(() => parseActivityDataIntegrityCommand(args, new Date("2026-09-03T00:00:00Z"))).toThrow(
      message,
    );
  });
});
