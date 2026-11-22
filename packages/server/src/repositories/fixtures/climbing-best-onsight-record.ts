import { climbingBestOnsightFixture } from "@dofek/training/fixtures/climbing-best-onsight";
import type { ClimbingLogEntryDetail } from "../../contracts/climbing-log-contracts.ts";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../climbing-test-helpers.ts";

const CLIMBING_BEST_ONSIGHT_SAMPLE_NAMES: Record<string, string> = {
  "44444444-4444-4444-8444-000000000001": "Blue Traverse",
  "44444444-4444-4444-8444-000000000002": "Granite Steps",
  "44444444-4444-4444-8444-000000000003": "North Wall",
  "44444444-4444-4444-8444-000000000004": "Fern Corner",
};

/**
 * Sample record detail for a selected best-onsight cell. The record id and provider come from
 * the real selection, and the sample climb matches its kind, grade, setting, and onsight send.
 * Unknown selections return null rather than substituting a different send.
 */
export function climbingBestOnsightRecordFixture(input: {
  providerId?: string;
  recordId?: string;
}): ClimbingLogEntryDetail | null {
  const { providerId, recordId } = input;
  if (!providerId || !recordId) return null;
  const row = climbingBestOnsightFixture().rows.find(
    (candidate) => candidate.gym?.recordId === recordId || candidate.outdoor?.recordId === recordId,
  );
  if (!row) return null;
  const setting = row.gym?.recordId === recordId ? "gym" : "outdoor";
  const cell = row[setting];
  if (!cell || cell.providerId !== providerId) return null;
  const name = CLIMBING_BEST_ONSIGHT_SAMPLE_NAMES[recordId];
  if (!name) return null;

  const climb = climbingClimbFixture(cell.providerId);
  climb.name = name;
  climb.kind = row.type === "bouldering" ? "boulder" : "route";
  climb.setting = setting === "gym" ? "indoor" : "outdoor";
  climb.publishedGrades = [{ value: cell.grade, system: cell.gradeSystem }];

  return climbingLogEntryFixture({
    id: cell.recordId,
    providerId: cell.providerId,
    climbId: climb.id,
    discipline: "rock_climbing",
    title: name,
    sourceName: cell.providerId,
    climbedOn: "2026-09-12",
    climb,
    attempts: [
      climbingAttemptFixture(cell.recordId, {
        outcome: "completed",
        ropeMethod: row.type === "bouldering" ? null : "lead",
        usedAid: false,
        fellOrHung: false,
        rockResultLabels: ["sent", "Onsight"],
      }),
    ],
  });
}
