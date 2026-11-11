import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { climbingGradeProgressionSchema } from "@dofek/training/climbing-progression";
import { StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import { safeParseData, safeParseRows } from "../lib/safe-parse";
import { captureException } from "../lib/telemetry";
import { colors } from "../theme";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart";
import { HangboardingSummary } from "./HangboardingSummary";

const climbingClimbTypeSchema = z.enum(["boulder", "route"]);

const mobileClimbingVolumeByGradeRowSchema = z.object({
  climbKind: climbingClimbTypeSchema,
  grade: z.string(),
  gradeSortValue: z.number(),
  attempts: z.number().nullable(),
  recordedAttempts: z.number().nullable(),
  sends: z.number(),
});

const mobileHangboardingDailyRowSchema = z.object({
  date: z.string(),
  sessionCount: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  workDurationSeconds: z.number().nonnegative().nullable(),
  restDurationSeconds: z.number().nonnegative().nullable(),
});

const mobileHangboardingSummarySchema = z.object({
  sessionCount: z.number().int().nonnegative(),
  totalDurationSeconds: z.number().nonnegative(),
  averageDurationSeconds: z.number().nonnegative().nullable(),
  totalWorkDurationSeconds: z.number().nonnegative().nullable(),
  totalRestDurationSeconds: z.number().nonnegative().nullable(),
  workIntervalCount: z.number().int().nonnegative().nullable(),
  averageHeartRate: z.number().nonnegative().nullable(),
  peakHeartRate: z.number().nonnegative().nullable(),
  latestSession: z
    .object({
      activityId: z.string(),
      startedAt: z.string(),
      planName: z.string().nullable(),
      boardName: z.string().nullable(),
      durationSeconds: z.number().nonnegative(),
    })
    .nullable(),
  daily: z.unknown(),
});

const mobileClimbingDataSchema = z.object({
  gradeProgression: climbingGradeProgressionSchema.nullable(),
  volumeByGrade: z.array(mobileClimbingVolumeByGradeRowSchema),
  hangboarding: z.object({
    ...mobileHangboardingSummarySchema.shape,
    daily: z.array(mobileHangboardingDailyRowSchema),
  }),
});

const mobileClimbingPayloadSchema = z.object({
  gradeProgression: z.unknown().optional(),
  volumeByGrade: z.unknown().optional(),
  hangboarding: z.unknown().optional(),
});

type MobileClimbingVolumeByGradeRow = z.infer<typeof mobileClimbingVolumeByGradeRowSchema>;
type MobileHangboardingSummary = z.infer<typeof mobileClimbingDataSchema>["hangboarding"];
type MobileClimbingData = z.infer<typeof mobileClimbingDataSchema>;

interface MobileClimbingParseResult {
  data: MobileClimbingData;
  error: Error | null;
}

const emptyClimbingData: MobileClimbingData = {
  gradeProgression: null,
  volumeByGrade: [],
  hangboarding: {
    sessionCount: 0,
    totalDurationSeconds: 0,
    averageDurationSeconds: null,
    totalWorkDurationSeconds: null,
    totalRestDurationSeconds: null,
    workIntervalCount: null,
    averageHeartRate: null,
    peakHeartRate: null,
    latestSession: null,
    daily: [],
  },
};

function parseMobileClimbingData(value: unknown): MobileClimbingParseResult {
  if (value == null) {
    return { data: emptyClimbingData, error: null };
  }

  const payloadResult = mobileClimbingPayloadSchema.safeParse(value);
  if (!payloadResult.success) {
    const parseError = new Error(
      `strain:climbing: Zod parse failed: ${payloadResult.error.message}`,
    );
    captureException(parseError, {
      context: "strain:climbing",
      zodError: payloadResult.error.format(),
    });
    return { data: emptyClimbingData, error: parseError };
  }

  const gradeProgression = safeParseData(
    climbingGradeProgressionSchema.nullable(),
    payloadResult.data.gradeProgression ?? null,
    "strain:climbing.gradeProgression",
  );
  const volumeByGrade = safeParseRows(
    mobileClimbingVolumeByGradeRowSchema,
    payloadResult.data.volumeByGrade ?? [],
    "strain:climbing.volumeByGrade",
  );
  const hangboardingResult = mobileHangboardingSummarySchema.safeParse(
    payloadResult.data.hangboarding ?? emptyClimbingData.hangboarding,
  );
  const hangboardingDaily = hangboardingResult.success
    ? safeParseRows(
        mobileHangboardingDailyRowSchema,
        hangboardingResult.data.daily,
        "strain:climbing.hangboarding.daily",
      )
    : { data: [], error: null };
  const hangboarding = hangboardingResult.success
    ? { ...hangboardingResult.data, daily: hangboardingDaily.data }
    : emptyClimbingData.hangboarding;
  const hangboardingError = hangboardingResult.success
    ? hangboardingDaily.error
    : (() => {
        const parseError = new Error(
          `strain:climbing.hangboarding: Zod parse failed: ${hangboardingResult.error.message}`,
        );
        captureException(parseError, {
          context: "strain:climbing.hangboarding",
          zodError: hangboardingResult.error.format(),
        });
        return parseError;
      })();

  return {
    data: {
      gradeProgression: gradeProgression.data ?? null,
      volumeByGrade: volumeByGrade.data,
      hangboarding,
    },
    error: gradeProgression.error ?? volumeByGrade.error ?? hangboardingError,
  };
}

class ClimbingSectionModel {
  readonly #data: MobileClimbingData;

  constructor(data: MobileClimbingData) {
    this.#data = data;
  }

  get gradeProgression() {
    return this.#data.gradeProgression;
  }

  get volumeRows(): MobileClimbingVolumeByGradeRow[] {
    return [...this.#data.volumeByGrade].sort(
      (left, right) => left.gradeSortValue - right.gradeSortValue,
    );
  }

  get hangboarding(): MobileHangboardingSummary {
    return this.#data.hangboarding;
  }
}

export function ClimbingTrainingCard({
  data,
  loading = false,
}: {
  data: unknown;
  loading?: boolean;
}) {
  const parsed = parseMobileClimbingData(data);
  const model = new ClimbingSectionModel(parsed.data);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Climbing</Text>
      {parsed.error !== null ? (
        <Text style={styles.errorText}>
          {userFacingErrorMessage(
            parsed.error,
            "Climbing data could not be loaded. Please try again.",
          )}
        </Text>
      ) : null}
      <ClimbingSection model={model} loading={loading} />
      <HangboardingSummary data={model.hangboarding} loading={loading} />
    </View>
  );
}

function ClimbingSection({ model, loading }: { model: ClimbingSectionModel; loading: boolean }) {
  return (
    <View style={styles.climbingStack}>
      <ClimbingGradeProgressionChart data={model.gradeProgression} loading={loading} />

      <View style={styles.climbingSubsection}>
        <Text style={styles.climbingSubsectionTitle}>Volume by Grade</Text>
        {model.volumeRows.length === 0 ? (
          <Text style={styles.activitiesEmpty}>No climbing volume by grade</Text>
        ) : (
          model.volumeRows.map((row) => (
            <View key={`${row.climbKind}-${row.grade}`} style={styles.climbingVolumeRow}>
              <Text style={styles.climbingGradeText}>{row.grade}</Text>
              {(row.attempts ?? row.recordedAttempts) !== null && (
                <Text style={styles.climbingMetaText}>
                  {row.attempts !== null
                    ? `${row.attempts} attempts`
                    : `${row.recordedAttempts} recorded attempts`}
                </Text>
              )}
              <Text style={styles.climbingMetaText}>{row.sends} sends</Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  activitiesEmpty: {
    color: colors.textTertiary,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
  climbingStack: {
    gap: 14,
  },
  climbingSubsection: {
    borderTopColor: colors.surfaceSecondary,
    borderTopWidth: 1,
    gap: 8,
    paddingTop: 12,
  },
  climbingSubsectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  climbingVolumeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  climbingGradeText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    minWidth: 48,
  },
  climbingMetaText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
