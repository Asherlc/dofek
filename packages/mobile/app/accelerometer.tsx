import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import {
	getMotionAuthorizationStatus,
	isAccelerometerRecordingAvailable,
	isRecordingActive,
} from "../modules/core-motion";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { rootStackScreenOptions } from "./_layout";

function StatusBadge({ label, value, color }: { label: string; value: string; color: string }) {
	return (
		<View style={styles.badge}>
			<Text style={styles.badgeLabel}>{label}</Text>
			<Text style={[styles.badgeValue, { color }]}>{value}</Text>
		</View>
	);
}

export default function AccelerometerScreen() {
	const available = isAccelerometerRecordingAvailable();
	const recording = available && isRecordingActive();
	const authStatus = available ? getMotionAuthorizationStatus() : "unavailable";

	const syncStatus = trpc.accelerometer.getSyncStatus.useQuery();
	const dailyCounts = trpc.accelerometer.getDailyCounts.useQuery({ days: 30 });

	const totalSamples =
		syncStatus.data?.reduce(
			(sum, device) => sum + device.sample_count,
			0,
		) ?? 0;

	const latestSync = syncStatus.data?.[0]?.latest_sample
		? new Date(syncStatus.data[0].latest_sample).toLocaleString()
		: "Never";

	return (
		<>
			<Stack.Screen options={{ ...rootStackScreenOptions, title: "Accelerometer" }} />
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<Text style={styles.sectionTitle}>Recording Status</Text>
					<View style={styles.badgeRow}>
						<StatusBadge
							label="Available"
							value={available ? "Yes" : "No"}
							color={available ? colors.positive : colors.negative}
						/>
						<StatusBadge
							label="Permission"
							value={authStatus}
							color={authStatus === "authorized" ? colors.positive : colors.negative}
						/>
						<StatusBadge
							label="Recording"
							value={recording ? "Active" : "Inactive"}
							color={recording ? colors.positive : colors.textTertiary}
						/>
					</View>
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>Sync Status</Text>
					<View style={styles.statRow}>
						<Text style={styles.statLabel}>Total samples</Text>
						<Text style={styles.statValue}>{totalSamples.toLocaleString()}</Text>
					</View>
					<View style={styles.statRow}>
						<Text style={styles.statLabel}>Latest sync</Text>
						<Text style={styles.statValue}>{latestSync}</Text>
					</View>
					{syncStatus.data?.map((device) => (
						<View key={device.device_id} style={styles.statRow}>
							<Text style={styles.statLabel}>{device.device_id}</Text>
							<Text style={styles.statValue}>
								{device.sample_count.toLocaleString()} samples
							</Text>
						</View>
					))}
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>Daily Coverage (last 30 days)</Text>
					{dailyCounts.data?.map((day) => (
						<View key={day.date} style={styles.coverageRow}>
							<Text style={styles.coverageDate}>{day.date}</Text>
							<View style={styles.coverageBarContainer}>
								<View
									style={[
										styles.coverageBar,
										{ width: `${Math.min(day.hours_covered / 24, 1) * 100}%` },
									]}
								/>
							</View>
							<Text style={styles.coverageHours}>{day.hours_covered.toFixed(1)}h</Text>
						</View>
					))}
					{(!dailyCounts.data || dailyCounts.data.length === 0) && (
						<Text style={styles.emptyText}>No data yet</Text>
					)}
				</View>
			</ScrollView>
		</>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: colors.background },
	section: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
	sectionTitle: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: 12 },
	badgeRow: { flexDirection: "row", gap: 12 },
	badge: {
		flex: 1,
		backgroundColor: colors.surface,
		borderRadius: 8,
		padding: 12,
		alignItems: "center",
	},
	badgeLabel: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
	badgeValue: { fontSize: 14, fontWeight: "600" },
	statRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingVertical: 8,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	statLabel: { fontSize: 14, color: colors.textSecondary },
	statValue: { fontSize: 14, fontWeight: "600", color: colors.text },
	coverageRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
	coverageDate: { width: 90, fontSize: 12, color: colors.textSecondary },
	coverageBarContainer: {
		flex: 1,
		height: 12,
		backgroundColor: colors.surface,
		borderRadius: 6,
		overflow: "hidden",
	},
	coverageBar: { height: "100%", backgroundColor: colors.accent, borderRadius: 6 },
	coverageHours: { width: 40, fontSize: 12, color: colors.textSecondary, textAlign: "right" },
	emptyText: { color: colors.textTertiary, textAlign: "center", paddingVertical: 16 },
});
