import type { ClickHouseCommandClient } from "./clickhouse.ts";

interface ClinicalMirrorTableMapping {
  sourceTableIdentifier: string;
  destinationTableIdentifier: string;
}

interface ClinicalMirrorStatus {
  currentFlowState: string;
  tableMappings: readonly ClinicalMirrorTableMapping[];
}

interface ClinicalMirrorApiClient {
  getMirrorStatus(mirrorName: string): Promise<ClinicalMirrorStatus>;
}

interface PeerDbSqlClient {
  query(queryText: string): Promise<unknown>;
}

const providerInventoryMirrorName = "dofek_provider_inventory_raw_analytics";
const canonicalClinicalSourceTable = "fitness.clinical_record";
const canonicalClinicalDestinationTable = "clinical_record";
const obsoleteClinicalMirrorTableNames = new Set([
  "fitness.lab_panel",
  "fitness.lab_result",
  "lab_panel",
  "lab_result",
]);
const obsoleteClinicalRawTableNames = ["lab_panel", "lab_result"] as const;
const mirrorStatePollIntervalMs = 1_000;
const mirrorStatePollTimeoutMs = 120_000;

function hasCanonicalClinicalMapping(status: ClinicalMirrorStatus): boolean {
  return status.tableMappings.some(
    (mapping) =>
      mapping.sourceTableIdentifier === canonicalClinicalSourceTable &&
      mapping.destinationTableIdentifier === canonicalClinicalDestinationTable,
  );
}

function hasObsoleteClinicalMapping(status: ClinicalMirrorStatus): boolean {
  return status.tableMappings.some(
    (mapping) =>
      obsoleteClinicalMirrorTableNames.has(mapping.sourceTableIdentifier) ||
      obsoleteClinicalMirrorTableNames.has(mapping.destinationTableIdentifier),
  );
}

export async function transitionLegacyClinicalMirror(
  peerDbClient: PeerDbSqlClient,
  peerDbMirrorApiClient: ClinicalMirrorApiClient,
  existingMirrorNames: Set<string>,
): Promise<boolean> {
  if (!existingMirrorNames.has(providerInventoryMirrorName)) {
    return false;
  }

  const status = await peerDbMirrorApiClient.getMirrorStatus(providerInventoryMirrorName);
  if (!hasObsoleteClinicalMapping(status)) {
    return false;
  }

  await peerDbClient.query(`DROP MIRROR ${providerInventoryMirrorName}`);
  existingMirrorNames.delete(providerInventoryMirrorName);
  return true;
}

export async function waitForCanonicalClinicalMirror(
  peerDbMirrorApiClient: ClinicalMirrorApiClient,
): Promise<void> {
  const deadline = Date.now() + mirrorStatePollTimeoutMs;
  while (true) {
    const status = await peerDbMirrorApiClient.getMirrorStatus(providerInventoryMirrorName);
    if (
      status.currentFlowState === "STATUS_RUNNING" &&
      hasCanonicalClinicalMapping(status) &&
      !hasObsoleteClinicalMapping(status)
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for PeerDB mirror ${providerInventoryMirrorName} to replace legacy clinical mappings with the canonical clinical record mapping`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, mirrorStatePollIntervalMs));
  }
}

export async function dropObsoleteClinicalRawTables(
  clickHouseClient: ClickHouseCommandClient,
): Promise<void> {
  for (const tableName of obsoleteClinicalRawTableNames) {
    await clickHouseClient.command({
      query: `DROP TABLE IF EXISTS postgres_fitness.${tableName}`,
    });
  }
}
