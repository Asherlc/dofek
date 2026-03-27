// @vitest-environment jsdom
import React from "react";
import { render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMotionAuthorizationStatus = vi.fn(() => "notDetermined");
const mockRequestMotionPermission = vi.fn(() =>
	Promise.resolve("authorized" as const),
);
const mockIsAccelerometerRecordingAvailable = vi.fn(() => true);
const mockIsRecordingActive = vi.fn(() => false);

let appStateCallback: ((state: string) => void) | null = null;

function stripStyle({ style: _s, contentContainerStyle: _cs, ...rest }: Record<string, unknown>) {
	return rest;
}

vi.mock("react-native", () => ({
	View: ({ children, ...props }: Record<string, unknown>) =>
		React.createElement("div", stripStyle(props), children as React.ReactNode),
	Text: ({ children, ...props }: Record<string, unknown>) =>
		React.createElement("span", stripStyle(props), children as React.ReactNode),
	ScrollView: ({ children, ...props }: Record<string, unknown>) =>
		React.createElement("div", stripStyle(props), children as React.ReactNode),
	StyleSheet: {
		create: <T extends Record<string, unknown>>(styles: T): T =>
			Object.fromEntries(
				Object.entries(styles).map(([key]) => [key, {}]),
			) as T,
		hairlineWidth: 1,
	},
	Switch: ({ value, ...props }: Record<string, unknown>) =>
		React.createElement("input", { ...stripStyle(props), type: "checkbox", checked: value }),
	AppState: {
		addEventListener: vi
			.fn()
			.mockImplementation(
				(_event: string, callback: (state: string) => void) => {
					appStateCallback = callback;
					return { remove: vi.fn() };
				},
			),
	},
}));

vi.mock("expo-router", () => ({
	Stack: {
		Screen: () => null,
	},
}));

vi.mock("../modules/core-motion", () => ({
	isAccelerometerRecordingAvailable: (...args: unknown[]) =>
		mockIsAccelerometerRecordingAvailable(...args),
	getMotionAuthorizationStatus: (...args: unknown[]) =>
		mockGetMotionAuthorizationStatus(...args),
	requestMotionPermission: (...args: unknown[]) =>
		mockRequestMotionPermission(...args),
	isRecordingActive: (...args: unknown[]) => mockIsRecordingActive(...args),
}));

vi.mock("../modules/whoop-ble", () => ({
	isBluetoothAvailable: () => false,
}));

vi.mock("../modules/watch-motion", () => ({
	getWatchSyncStatus: () => ({
		isSupported: true,
		isPaired: false,
		isReachable: false,
		isWatchAppInstalled: false,
		pendingFileCount: 0,
	}),
}));

vi.mock("../lib/trpc", () => ({
	trpc: {
		accelerometer: {
			getSyncStatus: {
				useQuery: () => ({ data: null, isLoading: false }),
			},
			getDailyCounts: {
				useQuery: () => ({ data: null, isLoading: false }),
			},
		},
		settings: {
			get: {
				useQuery: () => ({ data: null, isLoading: false }),
			},
			set: {
				useMutation: () => ({ mutate: vi.fn(), isPending: false }),
			},
		},
	},
}));

vi.mock("../theme", () => ({
	colors: {
		background: "#000",
		surface: "#111",
		surfaceSecondary: "#1a1a1a",
		border: "#222",
		text: "#fff",
		textSecondary: "#aaa",
		textTertiary: "#666",
		accent: "#00f",
		positive: "#0f0",
		negative: "#f00",
	},
}));

vi.mock("./_layout", () => ({
	rootStackScreenOptions: {},
}));

describe("AccelerometerScreen", () => {
	beforeEach(() => {
		mockGetMotionAuthorizationStatus.mockReturnValue("notDetermined");
		mockRequestMotionPermission.mockResolvedValue("authorized");
		mockIsAccelerometerRecordingAvailable.mockReturnValue(true);
		mockIsRecordingActive.mockReturnValue(false);
		appStateCallback = null;
	});

	it("updates permission status when app returns to foreground", async () => {
		// Start with notDetermined
		const { unmount } = render(
			React.createElement(
				(await import("./accelerometer")).default,
			),
		);

		expect(screen.getByText("notDetermined")).toBeTruthy();

		// Simulate the user granting permission in iOS settings,
		// then returning to the app
		mockGetMotionAuthorizationStatus.mockReturnValue("authorized");

		await act(async () => {
			appStateCallback?.("active");
		});

		expect(screen.getByText("Granted")).toBeTruthy();

		unmount();
	});

	it("requests permission on mount when status is notDetermined", async () => {
		const { unmount } = render(
			React.createElement(
				(await import("./accelerometer")).default,
			),
		);

		expect(mockRequestMotionPermission).toHaveBeenCalled();

		unmount();
	});
});
