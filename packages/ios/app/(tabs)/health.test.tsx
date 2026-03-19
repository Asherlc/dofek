// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const TEST_SERVER_URL = "https://test.dofek.example.com";

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
	requestPermissions: vi.fn(),
	queryQuantitySamples: vi.fn(),
	queryWorkouts: vi.fn(),
	querySleepSamples: vi.fn(),
	enableBackgroundDelivery: vi.fn(),
}));

vi.mock("../../lib/trpc", () => ({
	trpc: {
		healthKitSync: {
			pushQuantitySamples: { useMutation: () => ({ mutateAsync: vi.fn() }) },
			pushWorkouts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
			pushSleepSamples: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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
});
