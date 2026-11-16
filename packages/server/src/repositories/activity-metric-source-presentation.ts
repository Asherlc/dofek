import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import {
  activityMetricSourcePresentation,
  activityMetricSourceText,
} from "@dofek/providers/activity-metric-source";
import {
  type ActivitySourceTree,
  activityMetricSourceInheritance,
} from "@dofek/providers/activity-source-tree";
import { providerRecordLabel, providerSourceLabel } from "@dofek/providers/providers";
import type { ActivityMetricSources } from "../contracts/activity-metric-sources.ts";

interface ActivityMetricSourceRow {
  provider_id: string;
  device_id: string | null;
  source_id: string;
  activity_ids: string[];
}

export function presentActivityMetricSource(
  row: ActivityMetricSourceRow,
  hardware: ActivityHardware,
  sourceTree: ActivitySourceTree,
  peripheralName?: string,
): ActivityMetricSources[number]["sources"][number] {
  const inherited =
    row.device_id === null
      ? activityMetricSourceInheritance(sourceTree, row.activity_ids, row.provider_id)
      : null;
  const originalLabel =
    inherited?.label ??
    (row.provider_id === "apple_health" || row.provider_id === "whoop_ble"
      ? providerSourceLabel(row.provider_id, row.device_id)
      : providerRecordLabel(row.provider_id, peripheralName ?? row.device_id));
  const provenance = hardware.items.filter(
    (item) =>
      item.providerId === row.provider_id &&
      row.activity_ids.includes(item.activityId) &&
      (row.device_id === null || row.device_id === item.sourceName || row.device_id === item.label),
  );
  const role = provenance.some((item) => item.role === "recorder") ? "recorder" : "creator";
  const matching = provenance.filter((item) => item.role === role);
  const labels = [...new Set(matching.map((item) => item.label))];
  const name =
    labels.length === 1 &&
    row.activity_ids.every((id) => matching.some((item) => item.activityId === id))
      ? labels[0]
      : undefined;
  let label = originalLabel;
  if (name) {
    const includesHardwareName = originalLabel
      .replace(/\s+/g, " ")
      .toLowerCase()
      .includes(name.replace(/\s+/g, " ").toLowerCase());
    if (role === "recorder") {
      label = includesHardwareName ? originalLabel : `${originalLabel} · recorded by ${name}`;
    } else {
      const baseLabel =
        includesHardwareName && !inherited
          ? providerRecordLabel(row.provider_id, null)
          : originalLabel;
      label = `${baseLabel} · file created by ${name}`;
    }
  }
  const presentation =
    inherited?.presentation ??
    activityMetricSourcePresentation(row.provider_id, peripheralName ?? row.device_id, label, name);
  return {
    id: row.source_id,
    label,
    presentation:
      inherited && role === "recorder" && name && activityMetricSourceText(presentation) === null
        ? { ...presentation, displayName: name }
        : presentation,
  };
}
