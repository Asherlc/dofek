import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import {
	getMotionAuthorizationStatus,
	isAccelerometerRecordingAvailable,
	isRecordingActive,
} from "../modules/core-motion";
import { getWatchSyncStatus } from "../modules/watch-motion";
import {
	getBluetoothState,
	getConnectionState,
	getBufferedSampleCount,
} from "../modules/whoop-ble";
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

function StatusWarning({ message }: { message: string }) {
	return (
		<View style={styles.warningRow}>
			<Text style={styles.warningText}>{message}</Text>
		</View>
	);
}

function getRecordingWarning(available: boolean, authStatus: string, recording: boolean): string | null {
	if (!available) return "Accelerometer recording is not available on this device.";
	if (authStatus === "denied") return "Motion permission denied. Go to Settings \u2192 Dofek \u2192 Motion & Fitness to enable.";
	if (authStatus === "restricted") return "Motion access is restricted by device management.";
	if (authStatus === "notDetermined") return "Motion permission not yet requested. Reopen the app to trigger the prompt.";
	if (!recording) return "Recording not active. Try closing and reopening the app.";
	return null;
}

function getWatchWarning(watchStatus: { isPaired: boolean; isWatchAppInstalled: boolean; isReachable: boolean; pendingFileCount: number }): string | null {
	if (!watchStatus.isPaired) return "No Apple Watch paired with this iPhone.";
	if (!watchStatus.isWatchAppInstalled) return "Install the Dofek Watch app from the Watch app on your iPhone.";
	if (watchStatus.pendingFileCount > 10) return `${watchStatus.pendingFileCount} files pending transfer. Data may be delayed.`;
	return null;
}

function getWhoopWarning(bluetoothState: string, connectionState: string): string | null {
	if (bluetoothState === "uninitialized") return "Bluetooth not initialized. Enable WHOOP always-on recording in Settings.";
	if (bluetoothState === "poweredOff") return "Bluetooth is turned off. Enable it in Control Center or Settings.";
	if (bluetoothState === "unauthorized") return "Bluetooth permission denied. Go to Settings \u2192 Dofek \u2192 Bluetooth to enable.";
	if (bluetoothState === "unsupported") return "Bluetooth Low Energy is not supported on this device.";
	if (bluetoothState !== "poweredOn") return `Bluetooth state: ${bluetoothState}. Waiting for Bluetooth to be ready.`;
	if (connectionState === "idle") return "Not connected to WHOOP strap. Make sure the WHOOP app is running and the strap is nearby.";
	if (connectionState === "scanning") return "Scanning for WHOOP strap...";
	if (connectionState === "connecting") return "Connecting to WHOOP strap...";
	if (connectionState === "discoveringServices") return "Discovering WHOOP services...";
	if (connectionState === "ready") return "Connected but not streaming. IMU streaming may not have started.";
	return null;
}

export default function AccelerometerScreen() {
	const [available, setAvailable] = useState(isAccelerometerRecordingAvailable);
	const [recording, setRecording] = useState(false);
	const [authStatus, setAuthStatus] = useState<string>("unavailable");
	const [watchStatus, setWatchStatus] = useState(getWatchSyncStatus);
	const [whoopBleState, setWhoopBleState] = useState(getConnectionState);
	const [bluetoothState, setBluetoothState] = useState(getBluetoothState);
	const [whoopBuffered, setWhoopBuffered] = useState(0);

	const refreshStatus = useCallback(() => {
		const isAvailable = isAccelerometerRecordingAvailable();
		setAvailable(isAvailable);
		setRecording(isAvailable && isRecordingActive());
		setAuthStatus(isAvailable ? getMotionAuthorizationStatus() : "unavailable");
		setWatchStatus(getWatchSyncStatus());
		setWhoopBleState(getConnectionState());
		setBluetoothState(getBluetoothState());
		setWhoopBuffered(getBufferedSampleCount());
	}, []);

	// Refresh status when the screen comes into focus
	useFocusEffect(
		useCallback(() => {
			refreshStatus();
			// Poll every 3 seconds while the screen is visible
			const interval = setInterval(refreshStatus, 3000);
			return () => clearInterval(interval);
		}, [refreshStatus]),
	);

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

	// Collect all active problems for the top-level banner
	const problems: string[] = [];
	const recordingWarning = getRecordingWarning(available, authStatus, recording);
	if (recordingWarning) problems.push(`iPhone: ${recordingWarning}`);
	const watchWarning = getWatchWarning(watchStatus);
	if (watchWarning) problems.push(`Watch: ${watchWarning}`);
	const whoopWarning = getWhoopWarning(bluetoothState, whoopBleState);
	if (whoopWarning) problems.push(`WHOOP: ${whoopWarning}`);

	const noDataSources = !recording && !watchStatus.isWatchAppInstalled && whoopBleState !== "streaming";

	return (
		<>
			<Stack.Screen options={{ ...rootStackScreenOptions, title: "Accelerometer" }} />
			<ScrollView style={styles.container}>
				{problems.length > 0 && (
					<View style={styles.errorBanner}>
						<Text style={styles.errorBannerTitle}>
							{noDataSources ? "No active data sources" : "Issues detected"}
						</Text>
						{problems.map((problem) => (
							<Text key={problem} style={styles.errorBannerItem}>
								{`\u2022 ${problem}`}
							</Text>
						))}
					</View>
				)}

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
					{getRecordingWarning(available, authStatus, recording) && (
						<StatusWarning message={getRecordingWarning(available, authStatus, recording) as string} />
					)}
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>Apple Watch</Text>
					<View style={styles.badgeRow}>
						<StatusBadge
							label="Paired"
							value={watchStatus.isPaired ? "Yes" : "No"}
							color={watchStatus.isPaired ? colors.positive : colors.textTertiary}
						/>
						<StatusBadge
							label="App Installed"
							value={watchStatus.isWatchAppInstalled ? "Yes" : "No"}
							color={watchStatus.isWatchAppInstalled ? colors.positive : colors.textTertiary}
						/>
						<StatusBadge
							label="Pending"
							value={String(watchStatus.pendingFileCount)}
							color={watchStatus.pendingFileCount > 0 ? colors.accent : colors.textTertiary}
						/>
					</View>
					{getWatchWarning(watchStatus) && (
						<StatusWarning message={getWatchWarning(watchStatus) as string} />
					)}
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>WHOOP Strap</Text>
					<View style={styles.badgeRow}>
						<StatusBadge
							label="Bluetooth"
							value={bluetoothState}
							color={bluetoothState === "poweredOn" ? colors.positive : colors.negative}
						/>
						<StatusBadge
							label="Connection"
							value={whoopBleState}
							color={whoopBleState === "streaming" ? colors.positive : whoopBleState === "ready" ? colors.accent : colors.textTertiary}
						/>
						<StatusBadge
							label="Buffered"
							value={String(whoopBuffered)}
							color={whoopBuffered > 0 ? colors.accent : colors.textTertiary}
						/>
					</View>
					{getWhoopWarning(bluetoothState, whoopBleState) && (
						<StatusWarning message={getWhoopWarning(bluetoothState, whoopBleState) as string} />
					)}
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
	warningRow: {
		marginTop: 10,
		backgroundColor: `${colors.negative}15`,
		borderRadius: 8,
		padding: 10,
		borderLeftWidth: 3,
		borderLeftColor: colors.negative,
	},
	warningText: { fontSize: 13, color: colors.negative, lineHeight: 18 },
	errorBanner: {
		margin: 16,
		marginBottom: 0,
		backgroundColor: `${colors.negative}18`,
		borderRadius: 12,
		padding: 14,
		borderWidth: 1,
		borderColor: `${colors.negative}40`,
	},
	errorBannerTitle: {
		fontSize: 15,
		fontWeight: "700",
		color: colors.negative,
		marginBottom: 6,
	},
	errorBannerItem: {
		fontSize: 13,
		color: colors.negative,
		lineHeight: 20,
		paddingLeft: 4,
	},
});
