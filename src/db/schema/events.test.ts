import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  bodyRegion,
  breathworkSession,
  dexaScan,
  dexaScanRegion,
  fileUpload,
  fileUploadOutbox,
  imuSession,
  injuryEvent,
  journalEntry,
  journalQuestion,
  lifeEvents,
  menstrualPeriod,
  personalExperiment,
  personalExperimentCheckIn,
  providerDataDeletionOutbox,
  providerDataGeneration,
  sharedReport,
  subjectiveCheckIn,
  subjectiveSymptom,
  syncLog,
} from "./events.ts";

describe("event schema", () => {
  it("defines all event-domain tables in the fitness schema", () => {
    const tables = [
      providerDataGeneration,
      providerDataDeletionOutbox,
      fileUpload,
      fileUploadOutbox,
      syncLog,
      journalQuestion,
      journalEntry,
      bodyRegion,
      subjectiveCheckIn,
      subjectiveSymptom,
      injuryEvent,
      lifeEvents,
      personalExperiment,
      personalExperimentCheckIn,
      breathworkSession,
      sharedReport,
      menstrualPeriod,
      dexaScan,
      dexaScanRegion,
      imuSession,
    ];

    expect(tables.map((table) => getTableConfig(table).schema)).toEqual(
      Array(tables.length).fill("fitness"),
    );
  });

  it("keeps lifecycle records uniquely addressable and constrained", () => {
    const upload = getTableConfig(fileUpload);
    const deletionOutbox = getTableConfig(providerDataDeletionOutbox);
    const experiment = getTableConfig(personalExperiment);

    expect(upload.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining(["file_upload_owner_updated_idx", "file_upload_reconcile_idx"]),
    );
    expect(deletionOutbox.checks.map((check) => check.name)).toContain(
      "provider_data_deletion_outbox_status_valid",
    );
    expect(experiment.checks.map((check) => check.name)).toContain(
      "personal_experiment_stopped_at_consistent",
    );
  });
});
