import { formatDateLong, formatDurationMinutes } from "@dofek/format/format";
import {
  formatRecordLocalTime,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { providerLabel, providerRecordLabel } from "@dofek/providers/providers";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export interface SleepSourceReviewSession {
  sessionId: string;
  providerId: string;
  sourceName: string | null;
  sourceProviders: string[];
  localTimeContext: RecordLocalTimeContext;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
}

export interface SleepSourceReviewNight {
  date: string;
  durationMinutes: number | null;
  providerId: string | null;
  sourceName: string | null;
  sourceProviders: string[];
  selectedSessionId: string | null;
  localTimeContext: RecordLocalTimeContext;
  startedAt: string;
  endedAt: string | null;
  overlappingSessions: SleepSourceReviewSession[];
}

export function SleepSourceReview({ nights }: { nights: SleepSourceReviewNight[] }) {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        Sleep Sources
      </Text>
      <Text style={styles.description}>
        Review the canonical session selected for each night and any overlapping sessions.
      </Text>
      <View style={styles.nights}>
        {nights.map((night) => {
          const rowKey = night.selectedSessionId ?? night.date;
          const overlaps = night.overlappingSessions ?? [];
          const expanded = expandedSessionId === rowKey;
          const mergedSources = (night.sourceProviders ?? [])
            .filter((providerId) => providerId !== night.providerId)
            .map(providerLabel);

          return (
            <View key={rowKey} style={styles.night}>
              <Text style={styles.date}>{formatDateLong(night.date)}</Text>
              <Text style={styles.selectedSource}>
                {formatSource(night.providerId, night.sourceName)}
              </Text>
              <Text style={styles.sessionSummary}>
                {formatSessionTime(night.startedAt, night.endedAt, night.localTimeContext)} ·{" "}
                {night.durationMinutes == null
                  ? "Duration unavailable"
                  : formatDurationMinutes(night.durationMinutes)}
              </Text>
              {mergedSources.length > 0 && (
                <Text style={styles.mergedSources}>Merged with {mergedSources.join(", ")}</Text>
              )}
              {overlaps.length === 0 ? (
                <Text style={styles.noOverlap}>No overlapping sessions</Text>
              ) : (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Review ${overlaps.length} overlap${
                      overlaps.length === 1 ? "" : "s"
                    }`}
                    accessibilityState={{ expanded }}
                    onPress={() => setExpandedSessionId(expanded ? null : rowKey)}
                    style={styles.reviewButton}
                  >
                    <Text style={styles.reviewButtonText}>
                      Review {overlaps.length} overlap{overlaps.length === 1 ? "" : "s"}
                    </Text>
                  </Pressable>
                  {expanded && (
                    <View style={styles.overlaps}>
                      {overlaps.map((session) => (
                        <View key={session.sessionId} style={styles.overlap}>
                          <Text style={styles.overlapSource}>
                            {providerRecordLabel(session.providerId, session.sourceName)}
                          </Text>
                          <Text style={styles.sessionSummary}>
                            {formatSessionTime(
                              session.startedAt,
                              session.endedAt,
                              session.localTimeContext,
                            )}{" "}
                            ·{" "}
                            {session.durationMinutes == null
                              ? "Duration unavailable"
                              : formatDurationMinutes(session.durationMinutes)}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function formatSource(providerId: string | null, sourceName: string | null): string {
  return providerId == null ? "Unknown source" : providerRecordLabel(providerId, sourceName);
}

function formatSessionTime(
  startedAt: string,
  endedAt: string | null,
  context: RecordLocalTimeContext,
): string {
  const start = formatRecordLocalTime(startedAt, context, "start");
  if (start === "--") return "Local time unavailable";
  if (endedAt == null) return `${start} – End unavailable`;
  const end = formatRecordLocalTime(endedAt, context, "end");
  return end === "--" ? "Local time unavailable" : `${start} – ${end}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  title: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  description: {
    color: colors.textTertiary,
    fontSize: 12,
    lineHeight: 17,
  },
  nights: {
    gap: 12,
  },
  night: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
    paddingTop: 12,
  },
  date: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  selectedSource: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  sessionSummary: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  mergedSources: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  noOverlap: {
    color: colors.textTertiary,
    fontSize: 12,
    paddingTop: 2,
  },
  reviewButton: {
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  reviewButtonText: {
    color: colors.blue,
    fontSize: 12,
    fontWeight: "600",
  },
  overlaps: {
    backgroundColor: colors.background,
    borderRadius: 10,
    gap: 8,
    marginTop: 4,
    padding: 10,
  },
  overlap: {
    gap: 2,
  },
  overlapSource: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
});
