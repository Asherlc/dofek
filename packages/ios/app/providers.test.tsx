// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerActionLabel } from "./providers";

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSyncMutateAsync = vi.fn();

vi.mock("react-native", () => ({
	View: ({ children, ...props }: Record<string, unknown>) => {
		const { style: _s, contentContainerStyle: _cs, activeOpacity: _ao, numberOfLines: _nl, ...rest } = props;
		return React.createElement("div", rest, children as React.ReactNode);
	},
	Text: ({ children, ...props }: Record<string, unknown>) => {
		const { style: _s, numberOfLines: _nl, ...rest } = props;
		return React.createElement("span", rest, children as React.ReactNode);
	},
	ScrollView: ({ children, ...props }: Record<string, unknown>) => {
		const { style: _s, contentContainerStyle: _cs, ...rest } = props;
		return React.createElement("div", rest, children as React.ReactNode);
	},
	TouchableOpacity: ({ children, onPress, disabled, ...props }: Record<string, unknown>) => {
		const { style: _s, activeOpacity: _ao, ...rest } = props;
		return React.createElement("button", { type: "button", onClick: onPress, disabled, ...rest }, children as React.ReactNode);
	},
	ActivityIndicator: () => React.createElement("span", null, "Loading..."),
	StyleSheet: {
		create: <T extends Record<string, unknown>>(styles: T): T => styles,
		hairlineWidth: 1,
	},
}));

vi.mock("expo-router", () => ({
	useRouter: () => ({ push: mockPush, replace: mockReplace }),
	useLocalSearchParams: () => ({}),
}));

vi.mock("../theme", () => ({
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

vi.mock("../lib/auth-context", () => ({
	useAuth: () => ({
		serverUrl: "https://test.example.com",
		sessionToken: "test-token",
	}),
}));

vi.mock("../lib/share-import", () => ({
	importSharedFile: vi.fn(),
}));

vi.mock("@dofek/shared/format", () => ({
	formatRelativeTime: (date: string) => `${date} ago`,
}));

const mockProvidersQuery = vi.fn();
const mockStatsQuery = vi.fn();
const mockLogsQuery = vi.fn();
const mockActiveSyncsQuery = vi.fn();
const mockInvalidate = vi.fn();
const mockSyncStatusFetch = vi.fn();

vi.mock("../lib/trpc", () => ({
	trpc: {
		sync: {
			providers: { useQuery: (...args: unknown[]) => mockProvidersQuery(...args) },
			providerStats: { useQuery: (...args: unknown[]) => mockStatsQuery(...args) },
			logs: { useQuery: (...args: unknown[]) => mockLogsQuery(...args) },
			triggerSync: { useMutation: () => ({ mutateAsync: mockSyncMutateAsync }) },
			activeSyncs: { useQuery: (...args: unknown[]) => mockActiveSyncsQuery(...args) },
		},
		useUtils: () => ({
			sync: {
				providers: { invalidate: mockInvalidate },
				providerStats: { invalidate: mockInvalidate },
				logs: { invalidate: mockInvalidate },
				syncStatus: { fetch: mockSyncStatusFetch },
			},
		}),
	},
}));

const connectedProvider = {
	id: "wahoo",
	name: "Wahoo",
	authorized: true,
	importOnly: false,
	lastSyncedAt: "2026-03-19T12:00:00Z",
};

const disconnectedProvider = {
	id: "strava",
	name: "Strava",
	authorized: false,
	importOnly: false,
	lastSyncedAt: null,
};

function setupDefaultMocks() {
	mockProvidersQuery.mockReturnValue({
		data: [connectedProvider, disconnectedProvider],
		isLoading: false,
	});
	mockStatsQuery.mockReturnValue({ data: [], isLoading: false });
	mockLogsQuery.mockReturnValue({ data: [], isLoading: false });
	mockActiveSyncsQuery.mockReturnValue({ data: [] });
}

describe("providerActionLabel", () => {
	it("returns Sync for connected providers", () => {
		expect(providerActionLabel("connected")).toBe("Sync");
	});

	it("returns Connect for disconnected providers", () => {
		expect(providerActionLabel("not_connected")).toBe("Connect");
	});

	it("returns Connect for expired providers", () => {
		expect(providerActionLabel("expired")).toBe("Connect");
	});
});

describe("ProvidersScreen", () => {
	beforeEach(() => {
		mockPush.mockReset();
		mockReplace.mockReset();
		mockSyncMutateAsync.mockReset();
		mockProvidersQuery.mockReset();
		mockStatsQuery.mockReset();
		mockLogsQuery.mockReset();
		mockActiveSyncsQuery.mockReset();
		mockInvalidate.mockReset();
		mockSyncStatusFetch.mockReset();
		setupDefaultMocks();
	});

	it("renders Full sync link for connected providers", async () => {
		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		expect(screen.getByText("Full sync")).toBeTruthy();
	});

	it("does not render Full sync link for disconnected providers", async () => {
		mockProvidersQuery.mockReturnValue({
			data: [disconnectedProvider],
			isLoading: false,
		});

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		expect(screen.queryByText("Full sync")).toBeNull();
	});

	it("renders Full Sync All button alongside Sync All", async () => {
		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		expect(screen.getByText("Sync All")).toBeTruthy();
		expect(screen.getByText("Full Sync All")).toBeTruthy();
	});

	it("passes sinceDays: 7 when Sync button is clicked", async () => {
		mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
		mockSyncStatusFetch.mockResolvedValue({ status: "done", providers: { wahoo: { status: "done" } } });

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		fireEvent.click(screen.getByText("Sync"));

		await waitFor(() => {
			expect(mockSyncMutateAsync).toHaveBeenCalledWith({
				providerId: "wahoo",
				sinceDays: 7,
			});
		});
	});

	it("passes sinceDays: undefined when Full sync link is clicked", async () => {
		mockSyncMutateAsync.mockResolvedValue({ jobId: "job-2" });
		mockSyncStatusFetch.mockResolvedValue({ status: "done", providers: { wahoo: { status: "done" } } });

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		fireEvent.click(screen.getByText("Full sync"));

		await waitFor(() => {
			expect(mockSyncMutateAsync).toHaveBeenCalledWith({
				providerId: "wahoo",
				sinceDays: undefined,
			});
		});
	});

	it("passes sinceDays: 7 when Sync All is clicked", async () => {
		mockSyncMutateAsync.mockResolvedValue({ jobId: "job-3", providerJobs: [] });
		mockSyncStatusFetch.mockResolvedValue({ status: "done", providers: { wahoo: { status: "done" } } });

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		fireEvent.click(screen.getByText("Sync All"));

		await waitFor(() => {
			expect(mockSyncMutateAsync).toHaveBeenCalledWith({ sinceDays: 7 });
		});
	});

	it("passes sinceDays: undefined when Full Sync All is clicked", async () => {
		mockSyncMutateAsync.mockResolvedValue({ jobId: "job-4", providerJobs: [] });
		mockSyncStatusFetch.mockResolvedValue({ status: "done", providers: { wahoo: { status: "done" } } });

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		fireEvent.click(screen.getByText("Full Sync All"));

		await waitFor(() => {
			expect(mockSyncMutateAsync).toHaveBeenCalledWith({ sinceDays: undefined });
		});
	});
});
