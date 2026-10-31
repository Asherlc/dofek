import { formatRelativeTime } from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import type { WhoopSensorSnapshot } from "@dofek/providers/whoop-sensors";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useUnitConverter } from "../lib/units";
import type { WhoopBufferStreamDiagnostics } from "../modules/whoop-ble";
import { colors } from "../theme";
import { Card } from "./Card";
import { QueryStatePanel } from "./QueryStatePanel";

interface Props {
  data: WhoopSensorSnapshot | undefined;
  isLoading: boolean;
  error: string | null;
  units: UnitConverter;
  localCapture?: Pick<WhoopBufferStreamDiagnostics, "receivedCount" | "count" | "confirmedCount">;
}

export function WhoopSensorDetails({ data, isLoading, error, units, localCapture }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card title="Background sensors">
      {localCapture && (
        <Text style={styles.detail}>
          Captured on this phone: {localCapture.receivedCount} · Queued: {localCapture.count} ·
          Uploaded: {localCapture.confirmedCount}
        </Text>
      )}
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!data && isLoading && <QueryStatePanel variant="loading" title="Background sensors" />}
      {data && data.records.length === 0 && (
        <Text style={styles.detail}>No background sensor records uploaded yet.</Text>
      )}
      {data && data.records.length > 0 && (
        <>
          <Text style={styles.value}>
            {data.skinTemperatureC === null
              ? "Skin temperature unavailable"
              : `Skin temperature: ${formatMeasurementText(units.formatTemperature(data.skinTemperatureC))}`}
          </Text>
          {data.latestMeasuredAt && (
            <Text style={styles.detail}>Measured {formatRelativeTime(data.latestMeasuredAt)}</Text>
          )}
          {data.latestReceivedAt && (
            <Text style={styles.detail}>Captured {formatRelativeTime(data.latestReceivedAt)}</Text>
          )}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Raw sensor records"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
          >
            <Text style={styles.action}>Raw sensor records</Text>
          </TouchableOpacity>
          {expanded &&
            data.records.map((record) => (
              <View key={`${record.deviceId}:${record.captureId}`} style={styles.record}>
                <Text style={styles.value}>{record.deviceInfo.name ?? record.deviceId}</Text>
                <Text style={styles.detail}>
                  Record {record.layout} · {record.interpretation}
                </Text>
                {record.deviceInfo.firmware && (
                  <Text style={styles.detail}>Firmware {record.deviceInfo.firmware}</Text>
                )}
                {record.fields.map((field) => (
                  <Text key={field.label} style={styles.detail}>
                    {field.label}: {field.value} {field.unit}
                  </Text>
                ))}
                <Text selectable style={styles.bytes}>
                  {record.rawFrameHex}
                </Text>
              </View>
            ))}
        </>
      )}
    </Card>
  );
}

export function WhoopSensorPanel() {
  const units = useUnitConverter();
  const [localCapture, setLocalCapture] = useState<Props["localCapture"]>();
  const [captureError, setCaptureError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const native = await import("../modules/whoop-ble");
        const stats = native.getDataPathStats();
        if (!disposed) {
          setLocalCapture(stats.buffers.sensorRecords);
          setCaptureError(null);
        }
      } catch (error) {
        captureException(error, { context: "whoop-sensor-capture-status" });
        if (!disposed)
          setCaptureError("Local sensor queue could not be read. Retrying automatically.");
      }
    };
    void refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const query = trpc.whoopBleSync.sensorSnapshot.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  return (
    <WhoopSensorDetails
      units={units}
      localCapture={localCapture}
      data={query.data}
      isLoading={query.isLoading}
      error={[query.error?.message, captureError].filter(Boolean).join("\n") || null}
    />
  );
}

const styles = StyleSheet.create({
  value: { fontSize: 15, color: colors.text },
  detail: { fontSize: 12, color: colors.textSecondary },
  action: { fontSize: 14, color: colors.accent, paddingVertical: 8 },
  error: { fontSize: 13, color: colors.danger },
  record: { gap: 6, paddingVertical: 12, borderTopWidth: 1, borderColor: colors.border },
  bytes: { fontSize: 10, color: colors.textSecondary },
});
