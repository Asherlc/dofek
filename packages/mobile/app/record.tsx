import { formatActivityTypeLabel } from "@dofek/training/training";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  type ActivityRecorder,
  createActivityRecorder,
  type RecordingSnapshot,
} from "../lib/activity-recording";
import { createInertialMeasurementUnitService } from "../lib/inertial-measurement-unit-service";
import { createLocationAdapter } from "../lib/location-service";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import {
  isAccelerometerRecordingAvailable,
  queryRecordedData,
  startRecording,
} from "../modules/core-motion";
import {
  acknowledgeWatchSamples,
  getPendingWatchSamples,
  isWatchAppInstalled,
  isWatchPaired,
  requestWatchSync,
} from "../modules/watch-motion";
import {
  findWhoop,
  getBufferedSamples as getWhoopSamples,
  isBluetoothAvailable,
  startImuStreaming,
  stopImuStreaming,
  connect as whoopConnect,
} from "../modules/whoop-ble";
import { colors, fontSize, fonts, fontWeight, radius } from "../theme";

/** Activity types available for recording (GPS-based outdoor activities) */
const RECORDABLE_TYPES = [
  { type: "running", emoji: "\u{1F3C3}" },
  { type: "cycling", emoji: "\u{1F6B4}" },
  { type: "hiking", emoji: "\u{1F6B6}" },
  { type: "walking", emoji: "\u{1F6B6}" },
  { type: "swimming", emoji: "\u{1F3CA}" },
  { type: "trail_running", emoji: "\u{1F3C3}" },
  { type: "mountain_biking", emoji: "\u{1F6B5}" },
  { type: "skiing", emoji: "\u{26F7}\u{FE0F}" },
] as const;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatDistanceKm(meters: number): string {
  return (meters / 1000).toFixed(2);
}

function formatSpeed(metersPerSecond: number | null): string {
  if (metersPerSecond === null || metersPerSecond <= 0) return "--";
  const kmPerHour = metersPerSecond * 3.6;
  return kmPerHour.toFixed(1);
}

function formatPaceMinPerKm(metersPerSecond: number | null): string {
  if (metersPerSecond === null || metersPerSecond <= 0) return "--";
  const secondsPerKm = 1000 / metersPerSecond;
  const mins = Math.floor(secondsPerKm / 60);
  const secs = Math.round(secondsPerKm % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export default function RecordScreen() {
  const router = useRouter();
  const trpcClient = trpc.useUtils().client;
  const recorderRef = useRef<ActivityRecorder | null>(null);
  const [snapshot, setSnapshot] = useState<RecordingSnapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [activityName, setActivityName] = useState("");
  const [activityNotes, setActivityNotes] = useState("");

  // Create recorder once (with IMU service for phone + watch)
  const recorder = useMemo(() => {
    if (!recorderRef.current) {
      const imuService = createInertialMeasurementUnitService({
        coreMotion: {
          isAccelerometerRecordingAvailable,
          startRecording,
          queryRecordedData,
        },
        watch: {
          isAvailable: () => isWatchPaired() && isWatchAppInstalled(),
          requestSync: requestWatchSync,
          getPendingSamples: getPendingWatchSamples,
          acknowledgeSamples: acknowledgeWatchSamples,
        },
        whoopBle: {
          isAvailable: isBluetoothAvailable,
          findAndConnect: async () => {
            const device = await findWhoop();
            if (!device) return false;
            return whoopConnect(device.id);
          },
          startStreaming: startImuStreaming,
          stopStreaming: stopImuStreaming,
          getBufferedSamples: async () => {
            const samples = await getWhoopSamples();
            return samples.map((sample) => ({
              timestamp: sample.timestamp,
              x: sample.accelerometerX,
              y: sample.accelerometerY,
              z: sample.accelerometerZ,
              gyroscopeX: sample.gyroscopeX,
              gyroscopeY: sample.gyroscopeY,
              gyroscopeZ: sample.gyroscopeZ,
            }));
          },
        },
        trpcClient,
        deviceId: `iPhone (${Platform.OS} ${Platform.Version})`,
      });

      recorderRef.current = createActivityRecorder(
        createLocationAdapter(),
        trpcClient,
        "Dofek iOS",
        imuService,
      );
    }
    return recorderRef.current;
  }, [trpcClient]);

  // Subscribe to recorder updates
  useEffect(() => {
    const unsub = recorder.onUpdate(() => {
      setSnapshot(recorder.getSnapshot());
    });
    setSnapshot(recorder.getSnapshot());
    return unsub;
  }, [recorder]);

  // Tick timer for elapsed time display
  useEffect(() => {
    if (snapshot?.state === "recording") {
      timerRef.current = setInterval(() => {
        setSnapshot(recorder.getSnapshot());
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [snapshot?.state, recorder]);

  const handleStart = useCallback(
    async (activityType: string) => {
      await recorder.start(activityType);
    },
    [recorder],
  );

  const handlePause = useCallback(() => recorder.pause(), [recorder]);
  const handleResume = useCallback(() => recorder.resume(), [recorder]);

  const handleStop = useCallback(() => {
    Alert.alert("Stop Recording", "Are you sure you want to stop?", [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: () => recorder.stop() },
    ]);
  }, [recorder]);

  const handleSave = useCallback(async () => {
    try {
      const activityId = await recorder.save(
        activityName.trim() || null,
        activityNotes.trim() || null,
      );
      router.replace(`/activity/${activityId}`);
    } catch (error: unknown) {
      captureException(error, { context: "record-stop" });
    }
  }, [recorder, activityName, activityNotes, router]);

  const handleDiscard = useCallback(() => {
    Alert.alert("Discard Recording", "This will delete all recorded data.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          recorder.discard();
          router.back();
        },
      },
    ]);
  }, [recorder, router]);

  const state = snapshot?.state ?? "idle";

  // Activity type picker
  if (state === "idle") {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Record Activity</Text>
        <Text style={styles.subtitle}>Choose an activity type to start recording</Text>
        <View style={styles.typeGrid}>
          {RECORDABLE_TYPES.map(({ type, emoji }) => (
            <Pressable
              key={type}
              style={styles.typeButton}
              onPress={() => handleStart(type)}
              accessibilityRole="button"
              accessibilityLabel={formatActivityTypeLabel(type)}
            >
              <Text style={styles.typeEmoji}>{emoji}</Text>
              <Text style={styles.typeLabel}>{formatActivityTypeLabel(type)}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  // Post-recording save screen
  if (state === "saving") {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Save Activity</Text>

        <View style={styles.summaryCard}>
          <MetricRow label="Duration" value={formatElapsed(snapshot?.elapsedMs ?? 0)} />
          <MetricRow
            label="Distance"
            value={`${formatDistanceKm(snapshot?.distanceMeters ?? 0)} km`}
          />
          <MetricRow label="Samples" value={String(snapshot?.samples.length ?? 0)} />
        </View>

        <Text style={styles.fieldLabel}>Name (optional)</Text>
        <TextInput
          style={styles.textInput}
          value={activityName}
          onChangeText={setActivityName}
          placeholder={formatActivityTypeLabel(snapshot?.activityType ?? "")}
          placeholderTextColor={colors.textTertiary}
        />

        <Text style={styles.fieldLabel}>Notes (optional)</Text>
        <TextInput
          style={[styles.textInput, styles.textInputMultiline]}
          value={activityNotes}
          onChangeText={setActivityNotes}
          placeholder="How did it feel?"
          placeholderTextColor={colors.textTertiary}
          multiline
          numberOfLines={3}
        />

        <View style={styles.saveActions}>
          <Pressable style={styles.saveButton} onPress={handleSave} accessibilityRole="button">
            <Text style={styles.saveButtonText}>Save</Text>
          </Pressable>
          <Pressable
            style={styles.discardButton}
            onPress={handleDiscard}
            accessibilityRole="button"
          >
            <Text style={styles.discardButtonText}>Discard</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  // Error state
  if (state === "error") {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.errorText}>{snapshot?.error ?? "An error occurred"}</Text>
        <Pressable
          style={styles.discardButton}
          onPress={() => {
            recorder.discard();
            router.back();
          }}
          accessibilityRole="button"
        >
          <Text style={styles.discardButtonText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  // Recording / paused
  const isPaused = state === "paused";

  return (
    <View style={[styles.container, styles.recordingContainer]}>
      <Text style={styles.activityTypeHeader}>
        {formatActivityTypeLabel(snapshot?.activityType ?? "")}
      </Text>

      {isPaused && <Text style={styles.pausedBadge}>Paused</Text>}

      <View style={styles.metricsGrid}>
        <View style={styles.timerContainer}>
          <Text style={styles.timerValue}>{formatElapsed(snapshot?.elapsedMs ?? 0)}</Text>
          <Text style={styles.metricLabel}>Duration</Text>
        </View>

        <View style={styles.metricsRow}>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>
              {formatDistanceKm(snapshot?.distanceMeters ?? 0)}
            </Text>
            <Text style={styles.metricLabel}>Distance (km)</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>
              {formatPaceMinPerKm(snapshot?.currentSpeedMs ?? null)}
            </Text>
            <Text style={styles.metricLabel}>Pace (min/km)</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{formatSpeed(snapshot?.currentSpeedMs ?? null)}</Text>
            <Text style={styles.metricLabel}>Speed (km/h)</Text>
          </View>
        </View>

        <View style={styles.metricsRow}>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{snapshot?.samples.length ?? 0}</Text>
            <Text style={styles.metricLabel}>GPS Points</Text>
          </View>
        </View>
      </View>

      <View style={styles.controls}>
        {isPaused ? (
          <Pressable style={styles.resumeButton} onPress={handleResume} accessibilityRole="button">
            <Text style={styles.controlButtonText}>Resume</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.pauseButton} onPress={handlePause} accessibilityRole="button">
            <Text style={styles.controlButtonText}>Pause</Text>
          </Pressable>
        )}
        <Pressable style={styles.stopButton} onPress={handleStop} accessibilityRole="button">
          <Text style={styles.stopButtonText}>Stop</Text>
        </Pressable>
      </View>
    </View>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricRowLabel}>{label}</Text>
      <Text style={styles.metricRowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 20,
  },
  centered: {
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  title: {
    fontFamily: fonts.body,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: 20,
  },

  // Activity type picker
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  typeButton: {
    width: "47%",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    alignItems: "center",
    gap: 8,
  },
  typeEmoji: {
    fontSize: 32,
  },
  typeLabel: {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text,
    textAlign: "center",
  },

  // Recording
  recordingContainer: {
    justifyContent: "space-between",
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  activityTypeHeader: {
    fontFamily: fonts.body,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.medium,
    color: colors.textSecondary,
    textAlign: "center",
  },
  pausedBadge: {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.warning,
    textAlign: "center",
    marginTop: 4,
  },

  // Metrics
  metricsGrid: {
    alignItems: "center",
    gap: 20,
  },
  timerContainer: {
    alignItems: "center",
  },
  timerValue: {
    fontFamily: fonts.mono,
    fontSize: 56,
    fontWeight: fontWeight.bold,
    color: colors.text,
    letterSpacing: 2,
  },
  metricsRow: {
    flexDirection: "row",
    gap: 16,
  },
  metricCell: {
    alignItems: "center",
    flex: 1,
  },
  metricValue: {
    fontFamily: fonts.mono,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  metricLabel: {
    fontFamily: fonts.body,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 4,
  },

  // Controls
  controls: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
  },
  pauseButton: {
    backgroundColor: colors.warning,
    borderRadius: radius.full,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flex: 1,
    alignItems: "center",
  },
  resumeButton: {
    backgroundColor: colors.positive,
    borderRadius: radius.full,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flex: 1,
    alignItems: "center",
  },
  stopButton: {
    backgroundColor: colors.danger,
    borderRadius: radius.full,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flex: 1,
    alignItems: "center",
  },
  controlButtonText: {
    fontFamily: fonts.body,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: "#fff",
  },
  stopButtonText: {
    fontFamily: fonts.body,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: "#fff",
  },

  // Save screen
  summaryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    marginBottom: 20,
  },
  metricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  metricRowLabel: {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  metricRowValue: {
    fontFamily: fonts.mono,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text,
  },
  fieldLabel: {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  textInput: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 12,
    fontFamily: fonts.body,
    fontSize: fontSize.base,
    color: colors.text,
    marginBottom: 16,
  },
  textInputMultiline: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  saveActions: {
    gap: 12,
    marginTop: 8,
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: "center",
  },
  saveButtonText: {
    fontFamily: fonts.body,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: "#fff",
  },
  discardButton: {
    borderRadius: radius.lg,
    paddingVertical: 12,
    alignItems: "center",
  },
  discardButtonText: {
    fontFamily: fonts.body,
    fontSize: fontSize.sm,
    color: colors.danger,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: fontSize.base,
    color: colors.danger,
    textAlign: "center",
    marginBottom: 16,
  },
});
