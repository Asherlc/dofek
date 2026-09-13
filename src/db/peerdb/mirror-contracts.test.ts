import { describe, expect, it } from "vitest";
import { type PeerDbMirrorTableContract, peerDbMirrorContracts } from "./mirror-contracts.ts";

function mapping(mirrorName: string, sourceTableIdentifier: string): PeerDbMirrorTableContract {
  const mirror = peerDbMirrorContracts.find((candidate) => candidate.name === mirrorName);
  if (!mirror) throw new Error(`Missing mirror ${mirrorName}`);
  const tableMapping = mirror.tableMappings.find(
    (candidate) => candidate.sourceTableIdentifier === sourceTableIdentifier,
  );
  if (!tableMapping) {
    throw new Error(`Missing table ${sourceTableIdentifier} in mirror ${mirrorName}`);
  }
  return tableMapping;
}

describe("PeerDB mirror contracts", () => {
  it("defines every managed mirror and source table exactly once", () => {
    expect(peerDbMirrorContracts.map(({ name }) => name)).toEqual([
      "dofek_fitness_raw_analytics",
      "dofek_provider_inventory_raw_analytics",
      "dofek_sensor_priority_raw_analytics",
    ]);

    for (const mirror of peerDbMirrorContracts) {
      expect(
        new Set(mirror.tableMappings.map(({ sourceTableIdentifier }) => sourceTableIdentifier)),
      ).toHaveProperty("size", mirror.tableMappings.length);
    }
  });

  it("excludes provider-derived columns removed by ClickHouse migration 0085", () => {
    expect(mapping("dofek_fitness_raw_analytics", "fitness.daily_metrics").exclude).toEqual([
      "active_energy_kcal",
      "basal_energy_kcal",
      "recovery_high_minutes",
      "resilience_level",
      "stress_high_minutes",
    ]);
    expect(mapping("dofek_fitness_raw_analytics", "fitness.sleep_session").exclude).toEqual([
      "sleep_need_baseline_minutes",
      "sleep_need_from_debt_minutes",
      "sleep_need_from_nap_minutes",
      "sleep_need_from_strain_minutes",
    ]);
    expect(
      mapping("dofek_fitness_raw_analytics", "fitness.daily_metrics")
        .allowAbsentExcludedSourceColumns,
    ).toEqual(["recovery_high_minutes", "resilience_level", "stress_high_minutes"]);
    expect(
      mapping("dofek_fitness_raw_analytics", "fitness.sleep_session")
        .allowAbsentExcludedSourceColumns,
    ).toEqual([
      "sleep_need_baseline_minutes",
      "sleep_need_from_debt_minutes",
      "sleep_need_from_nap_minutes",
      "sleep_need_from_strain_minutes",
    ]);
  });

  it("assigns processing markers to their exact ClickHouse destinations", () => {
    expect(
      peerDbMirrorContracts.map(({ name, processingMarker }) => [name, processingMarker]),
    ).toEqual([
      [
        "dofek_fitness_raw_analytics",
        {
          datasetKey: "activity",
          destinationTableIdentifier: "processing_flow_marker",
          flow: "dofek_fitness_raw_analytics",
        },
      ],
      [
        "dofek_provider_inventory_raw_analytics",
        {
          datasetKey: "providers",
          destinationTableIdentifier: "processing_flow_marker_provider_inventory",
          flow: "dofek_provider_inventory_raw_analytics",
        },
      ],
      ["dofek_sensor_priority_raw_analytics", undefined],
    ]);
  });
});
