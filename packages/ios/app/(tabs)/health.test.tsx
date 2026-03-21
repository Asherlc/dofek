// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SERVER_URL = "https://test.dofek.example.com";
const mockGetRequestStatus = vi.fn();
const mockRequestPermissions = vi.fn();
const mockQueryDailyStatistics = vi.fn();
const mockQueryQuantitySamples = vi.fn();
const mockQueryWorkouts = vi.fn();
const mockQuerySleepSamples = vi.fn();
const mockEnableBackgroundDelivery = vi.fn();
const mockPushQuantityMutate = vi.fn();
const mockPushWorkoutsMutate = vi.fn();
const mockPushSleepMutate = vi.fn();

const mockUseAuth = vi.fn(() => ({
	user: { name: "Test User" },
	serverUrl: TEST_SERVER_URL,
	logout: vi.fn(),
	isLoading: false,
	sessionToken: "test-token",
	onLoginSuccess: vi.fn(),
}));

// Mock react-native primitives as DOM equivalents (strip style props to avoid jsdom issues)
function stripStyles({ style: _s, contentContainerStyle: _cs, activeOpacity: _ao, numberOfLines: _nl, ...rest }: Record<string, unknown>) {
	return rest;
}

vi.mock("react-native", () => ({
	View: ({ children, ...props }: Record<string, unknown>) =>
		React.createElement("div", stripStyles(props), children as React.ReactNode),
	Text: ({ children, ...props }: Record<string, unknown>) =>
		React.createElement("span", stripStyles(props), children as React.ReactNode),
	ScrollView: ({ children, ...props }: Record<string, unknown>) =>
		React.createElement("div", stripStyles(props), children as React.ReactNode),
	TouchableOpacity: ({ children, onPress, disabled, ...props }: Record<string, unknown>) =>
		React.createElement("button", { type: "button", onClick: onPress, disabled, ...stripStyles(props) }, children as React.ReactNode),
	StyleSheet: {
		create: <T extends Record<string, unknown>>(styles: T): T => styles,
		hairlineWidth: 1,
	},
	Alert: { alert: vi.fn() },
	useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock("expo-router", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../../modules/health-kit", () => ({
	isAvailable: () => true,
	getRequestStatus: mockGetRequestStatus,
	requestPermissions: mockRequestPermissions,
	queryDailyStatistics: mockQueryDailyStatistics,
	queryQuantitySamples: mockQueryQuantitySamples,
	queryWorkouts: mockQueryWorkouts,
	querySleepSamples: mockQuerySleepSamples,
	enableBackgroundDelivery: mockEnableBackgroundDelivery,
}));

const mockSettingsGet = vi.fn();
const mockSettingsSetMutate = vi.fn();

vi.mock("../../lib/trpc", () => ({
	trpc: {
		healthKitSync: {
			pushQuantitySamples: { useMutation: () => ({ mutateAsync: mockPushQuantityMutate }) },
			pushWorkouts: { useMutation: () => ({ mutateAsync: mockPushWorkoutsMutate }) },
			pushSleepSamples: { useMutation: () => ({ mutateAsync: mockPushSleepMutate }) },
		},
		settings: {
			get: { useQuery: (...args: unknown[]) => mockSettingsGet(...args) },
			set: { useMutation: () => ({ mutateAsync: mockSettingsSetMutate }) },
		},
	},
}));

vi.mock("../../theme", () => ({
	colors: {
		background: "#000",
		surface: "#1a1a1a",
		surfaceSecondary: "#2a2a2a",
		accent: "#0af",
		text: "#fff",
		textSecondary: "#999",
		textTertiary: "#666",
		danger: "#f00",
		positive: "#0f0",
		warning: "#ff0",
		teal: "#0ff",
		purple: "#a0f",
		blue: "#00f",
		green: "#0f0",
		orange: "#f80",
	},
}));

vi.mock("../../lib/auth-context", () => ({
	useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

describe("HealthScreen", () => {
	beforeEach(() => {
		mockGetRequestStatus.mockReset();
		mockGetRequestStatus.mockResolvedValue("shouldRequest");
		mockRequestPermissions.mockReset();
		mockQueryDailyStatistics.mockReset();
		mockQueryQuantitySamples.mockReset();
		mockQueryWorkouts.mockReset();
		mockQuerySleepSamples.mockReset();
		mockEnableBackgroundDelivery.mockReset();
		mockPushQuantityMutate.mockReset();
		mockPushWorkoutsMutate.mockReset();
		mockPushSleepMutate.mockReset();
		mockSettingsGet.mockReset();
		mockSettingsSetMutate.mockReset();

		mockQueryDailyStatistics.mockResolvedValue([]);
		mockQueryQuantitySamples.mockResolvedValue([]);
		mockQueryWorkouts.mockResolvedValue([]);
		mockQuerySleepSamples.mockResolvedValue([]);
		mockPushQuantityMutate.mockResolvedValue({ inserted: 0, errors: [] });
		mockPushWorkoutsMutate.mockResolvedValue({ inserted: 0 });
		mockPushSleepMutate.mockResolvedValue({ inserted: 0 });
		// Default: backfill already completed
		mockSettingsGet.mockReturnValue({ data: { value: true }, isLoading: false });
	});

	it("hides request permissions button when permissions already granted", async () => {
		mockGetRequestStatus.mockResolvedValue("unnecessary");
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		await waitFor(() => {
			expect(screen.getByText("HealthKit permissions granted.")).toBeTruthy();
		});
		expect(screen.queryByText("Request Permissions")).toBeNull();
	});

	it("shows request permissions button when permissions not yet requested", async () => {
		mockGetRequestStatus.mockResolvedValue("shouldRequest");
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		await waitFor(() => {
			expect(screen.getByText("Request Permissions")).toBeTruthy();
		});
	});

	it("renders the server URL from auth context", async () => {
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		expect(screen.getByText(TEST_SERVER_URL)).toBeTruthy();
	});

	it("renders the user name from auth context", async () => {
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		expect(screen.getByText("Test User")).toBeTruthy();
	});

	it("does not render server row when serverUrl is empty", async () => {
		mockUseAuth.mockReturnValueOnce({
			user: { name: "Test User" },
			serverUrl: "",
			logout: vi.fn(),
			isLoading: false,
			sessionToken: "test-token",
			onLoginSuccess: vi.fn(),
		});
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		expect(screen.queryByText("Server")).toBeNull();
	});

	it("renders sync range selector with all options", async () => {
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		expect(screen.getByText("7d")).toBeTruthy();
		expect(screen.getByText("30d")).toBeTruthy();
		expect(screen.getByText("90d")).toBeTruthy();
		expect(screen.getByText("1y")).toBeTruthy();
		expect(screen.getByText("All")).toBeTruthy();
	});

	it("defaults to All when backfill has not been completed", async () => {
		mockSettingsGet.mockReturnValue({ data: null, isLoading: false });
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		expect(screen.getByText("Sync all health data to the server.")).toBeTruthy();
	});

	it("defaults to 7d when backfill has been completed", async () => {
		mockSettingsGet.mockReturnValue({ data: { value: true }, isLoading: false });
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		expect(screen.getByText("Sync the last 7 days of health data to the server.")).toBeTruthy();
	});

	it("uses selected range when syncing", async () => {
		mockSettingsGet.mockReturnValue({ data: { value: true }, isLoading: false });
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);

		// Switch to 30d
		fireEvent.click(screen.getByText("30d"));
		fireEvent.click(screen.getByText("Sync Now"));

		await waitFor(() => {
			// Additive types are queried first via queryDailyStatistics
			expect(mockQueryDailyStatistics).toHaveBeenCalled();
		});

		// The start date should be ~30 days ago, not 7
		const firstCallStartDate = mockQueryDailyStatistics.mock.calls[0][1] as string;
		const startDate = new Date(firstCallStartDate);
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		// Allow 1 second tolerance
		expect(Math.abs(startDate.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(1000);
	});

	it("uses epoch start date when All is selected", async () => {
		mockSettingsGet.mockReturnValue({ data: null, isLoading: false });
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);

		// All should be selected by default (no backfill done)
		fireEvent.click(screen.getByText("Sync Now"));

		await waitFor(() => {
			// Additive types are queried first via queryDailyStatistics
			expect(mockQueryDailyStatistics).toHaveBeenCalled();
		});

		const firstCallStartDate = mockQueryDailyStatistics.mock.calls[0][1] as string;
		const startDate = new Date(firstCallStartDate);
		// Epoch: 1970-01-01T00:00:00.000Z
		expect(startDate.getTime()).toBe(0);
	});

	it("marks backfill as completed after successful all-time sync", async () => {
		mockSettingsGet.mockReturnValue({ data: null, isLoading: false });
		mockSettingsSetMutate.mockResolvedValue({ key: "healthkit_backfill_completed", value: true });

		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);

		fireEvent.click(screen.getByText("Sync Now"));

		await waitFor(() => {
			expect(mockSettingsSetMutate).toHaveBeenCalledWith({
				key: "healthkit_backfill_completed",
				value: true,
			});
		});
	});

	it("does not mark backfill when syncing a specific range", async () => {
		mockSettingsGet.mockReturnValue({ data: { value: true }, isLoading: false });

		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);

		// Default is 7d when backfill is done
		fireEvent.click(screen.getByText("Sync Now"));

		await waitFor(() => {
			expect(mockQueryQuantitySamples).toHaveBeenCalled();
		});

		// Wait for sync to complete
		await waitFor(() => {
			expect(screen.getByText(/Synced/)).toBeTruthy();
		});

		expect(mockSettingsSetMutate).not.toHaveBeenCalled();
	});

	it("shows enabled state after enabling background delivery", async () => {
		mockEnableBackgroundDelivery.mockResolvedValue(true);
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);

		fireEvent.click(screen.getByText("Enable Background Delivery"));

		await waitFor(() => {
			expect(screen.getByText("Background Delivery Enabled")).toBeTruthy();
		});

		// Button should be disabled after enabling
		const button = screen.getByText("Background Delivery Enabled").closest("button");
		expect(button).toHaveProperty("disabled", true);
	});

	it("queries skin temperature from HealthKit during sync", async () => {
		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		fireEvent.click(screen.getByText("Sync Now"));

		await waitFor(() => {
			expect(mockQueryQuantitySamples).toHaveBeenCalled();
		});

		const queriedTypes = mockQueryQuantitySamples.mock.calls.map(
			(call: unknown[]) => call[0] as string,
		);
		expect(queriedTypes).toContain(
			"HKQuantityTypeIdentifierAppleSleepingWristTemperature",
		);
	});

	it("normalizes missing workout optional fields to null before sync", async () => {
		mockQueryWorkouts.mockResolvedValueOnce([
			{
				uuid: "workout-1",
				workoutType: "35",
				startDate: "2026-03-01T10:00:00.000Z",
				endDate: "2026-03-01T11:00:00.000Z",
				duration: 3600,
				sourceName: "Apple Watch",
				sourceBundle: "com.apple.health",
			},
		]);

		const { default: HealthScreen } = await import("./health");
		render(<HealthScreen />);
		fireEvent.click(screen.getByText("Sync Now"));

		await waitFor(() => {
			expect(mockPushWorkoutsMutate).toHaveBeenCalledTimes(1);
		});
		const pushInput = mockPushWorkoutsMutate.mock.calls[0][0] as {
			workouts: Array<{ totalDistance?: number | null; totalEnergyBurned?: number | null }>;
		};
		expect(pushInput.workouts[0]?.totalDistance).toBeNull();
		expect(pushInput.workouts[0]?.totalEnergyBurned).toBeNull();
	});
});
