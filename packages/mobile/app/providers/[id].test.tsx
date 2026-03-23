// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAlertFn = vi.fn();

vi.mock("react-native", () => ({
	View: ({ children, ...props }: Record<string, unknown>) => {
		const { style: _s, contentContainerStyle: _cs, activeOpacity: _ao, ...rest } = props;
		return React.createElement("div", rest, children as React.ReactNode);
	},
	Text: ({ children, ...props }: Record<string, unknown>) => {
		const { style: _s, numberOfLines: _nl, ...rest } = props;
		return React.createElement("span", rest, children as React.ReactNode);
	},
	ScrollView: ({ children, ...props }: Record<string, unknown>) => {
		const { style: _s, contentContainerStyle: _cs, showsHorizontalScrollIndicator: _sh, horizontal: _h, ...rest } = props;
		return React.createElement("div", rest, children as React.ReactNode);
	},
	TouchableOpacity: ({ children, onPress, disabled, ...props }: Record<string, unknown>) => {
		const { style: _s, activeOpacity: _ao, ...rest } = props;
		return React.createElement("button", { type: "button", onClick: onPress, disabled, ...rest }, children as React.ReactNode);
	},
	Pressable: ({ children, onPress, disabled, ...props }: Record<string, unknown>) => {
		const { style: _s, ...rest } = props;
		return React.createElement("button", { type: "button", onClick: onPress, disabled, ...rest }, children as React.ReactNode);
	},
	TextInput: ({ placeholder, value, onChangeText, ...props }: Record<string, unknown>) => {
		const { style: _s, placeholderTextColor: _pc, keyboardType: _kt, secureTextEntry: _se, autoCapitalize: _ac, autoCorrect: _acr, ...rest } = props;
		return React.createElement("input", {
			type: "text",
			placeholder,
			value: value as string,
			onChange: (e: React.ChangeEvent<HTMLInputElement>) => (onChangeText as (text: string) => void)?.(e.target.value),
			...rest,
		});
	},
	Modal: ({ children, visible, onRequestClose, ...props }: Record<string, unknown>) => {
		if (!visible) return null;
		const { animationType: _at, transparent: _t, presentationStyle: _ps, ...rest } = props;
		return React.createElement("div", { role: "dialog", ...rest }, children as React.ReactNode);
	},
	ActivityIndicator: () => React.createElement("span", null, "Loading..."),
	Alert: { alert: mockAlertFn },
	Linking: { openURL: vi.fn() },
	StyleSheet: {
		create: <T extends Record<string, unknown>>(s: T): T => s,
		hairlineWidth: 1,
	},
}));

const mockBack = vi.fn();
const mockUseLocalSearchParams = vi.fn().mockReturnValue({ id: "wahoo" });

vi.mock("expo-router", () => ({
	useRouter: () => ({ back: mockBack, push: vi.fn(), replace: vi.fn() }),
	useLocalSearchParams: (...args: unknown[]) => mockUseLocalSearchParams(...args),
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
	useAuth: () => ({
		serverUrl: "https://test.example.com",
		sessionToken: "test-token",
	}),
}));

vi.mock("@dofek/format/format", () => ({
	formatRelativeTime: (date: string) => `${date} ago`,
	formatTime: (date: string) => date,
}));

const mockProvidersQuery = vi.fn();
const mockProviderStatsQuery = vi.fn();
const mockRecordsQuery = vi.fn();
const mockLogsQuery = vi.fn();
const mockSyncMutateAsync = vi.fn();
const mockDisconnectMutateAsync = vi.fn();
const mockInvalidateProviders = vi.fn();
const mockInvalidateProviderStats = vi.fn();
const mockInvalidateLogs = vi.fn();
const mockSyncStatusFetch = vi.fn();

vi.mock("../../lib/trpc", () => ({
	trpc: {
		sync: {
			providers: { useQuery: (...args: unknown[]) => mockProvidersQuery(...args) },
			providerStats: { useQuery: (...args: unknown[]) => mockProviderStatsQuery(...args) },
			triggerSync: {
				useMutation: () => ({ mutateAsync: mockSyncMutateAsync, isPending: false }),
			},
		},
		providerDetail: {
			records: { useQuery: (...args: unknown[]) => mockRecordsQuery(...args) },
			logs: { useQuery: (...args: unknown[]) => mockLogsQuery(...args) },
			disconnect: {
				useMutation: () => ({ mutateAsync: mockDisconnectMutateAsync, isPending: false }),
			},
		},
		useUtils: () => ({
			sync: {
				providers: { invalidate: mockInvalidateProviders },
				providerStats: { invalidate: mockInvalidateProviderStats },
				logs: { invalidate: mockInvalidateLogs },
				syncStatus: { fetch: mockSyncStatusFetch },
			},
		}),
	},
}));

const authorizedProvider = {
	id: "wahoo",
	name: "Wahoo",
	authType: "oauth",
	authorized: true,
	importOnly: false,
	lastSyncedAt: "2026-03-19T12:00:00Z",
	needsOAuth: false,
};

const unauthorizedProvider = {
	id: "strava",
	name: "Strava",
	authType: "oauth",
	authorized: false,
	importOnly: false,
	lastSyncedAt: null,
	needsOAuth: false,
};

const importOnlyProvider = {
	id: "strong-csv",
	name: "Strong",
	authType: "none",
	authorized: true,
	importOnly: true,
	lastSyncedAt: null,
	needsOAuth: false,
};

function setupDefaultMocks() {
	mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
	mockProviderStatsQuery.mockReturnValue({ data: [], isLoading: false });
	mockRecordsQuery.mockReturnValue({ data: { rows: [] }, isLoading: false });
	mockLogsQuery.mockReturnValue({ data: [], isLoading: false });
}

describe("ProviderDetailScreen", () => {
	beforeEach(() => {
		mockBack.mockReset();
		mockUseLocalSearchParams.mockReturnValue({ id: "wahoo" });
		mockSyncMutateAsync.mockReset();
		mockDisconnectMutateAsync.mockReset();
		mockInvalidateProviders.mockReset();
		mockInvalidateProviderStats.mockReset();
		mockInvalidateLogs.mockReset();
		mockSyncStatusFetch.mockReset();
		mockAlertFn.mockReset();
		setupDefaultMocks();
	});

	describe("Sync Controls", () => {
		it("renders sync controls card when provider is authorized and not importOnly", async () => {
			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			expect(screen.getByText("Sync Controls")).toBeTruthy();
			expect(screen.getByText("Sync Last 7 Days")).toBeTruthy();
			expect(screen.getByText("Full Sync")).toBeTruthy();
		});

		it("does not render sync controls card when provider is not authorized", async () => {
			mockUseLocalSearchParams.mockReturnValue({ id: "strava" });
			mockProvidersQuery.mockReturnValue({ data: [unauthorizedProvider], isLoading: false });

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			expect(screen.queryByText("Sync Controls")).toBeNull();
			expect(screen.queryByText("Sync Last 7 Days")).toBeNull();
			expect(screen.queryByText("Full Sync")).toBeNull();
		});

		it("does not render sync controls card when provider is importOnly", async () => {
			mockUseLocalSearchParams.mockReturnValue({ id: "strong-csv" });
			mockProvidersQuery.mockReturnValue({ data: [importOnlyProvider], isLoading: false });

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			expect(screen.queryByText("Sync Controls")).toBeNull();
			expect(screen.queryByText("Sync Last 7 Days")).toBeNull();
		});

		it("triggers sync with sinceDays=7 when Sync Last 7 Days is clicked", async () => {
			mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
			mockSyncStatusFetch.mockResolvedValue({
				status: "done",
				percentage: 100,
				providers: { wahoo: { status: "done", message: "Done" } },
			});

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			fireEvent.click(screen.getByText("Sync Last 7 Days"));

			await waitFor(() => {
				expect(mockSyncMutateAsync).toHaveBeenCalledWith({
					providerId: "wahoo",
					sinceDays: 7,
				});
			});
		});

		it("triggers sync with sinceDays=undefined when Full Sync is clicked", async () => {
			mockSyncMutateAsync.mockResolvedValue({ jobId: "job-2" });
			mockSyncStatusFetch.mockResolvedValue({
				status: "done",
				percentage: 100,
				providers: { wahoo: { status: "done", message: "Done" } },
			});

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			fireEvent.click(screen.getByText("Full Sync"));

			await waitFor(() => {
				expect(mockSyncMutateAsync).toHaveBeenCalledWith({
					providerId: "wahoo",
					sinceDays: undefined,
				});
			});
		});

		it("triggers custom days sync with parsed number when valid input is provided", async () => {
			mockSyncMutateAsync.mockResolvedValue({ jobId: "job-3" });
			mockSyncStatusFetch.mockResolvedValue({
				status: "done",
				percentage: 100,
				providers: { wahoo: { status: "done", message: "Done" } },
			});

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			const input = screen.getByPlaceholderText("Days");
			fireEvent.change(input, { target: { value: "90" } });
			fireEvent.click(screen.getByText("Sync Range"));

			await waitFor(() => {
				expect(mockSyncMutateAsync).toHaveBeenCalledWith({
					providerId: "wahoo",
					sinceDays: 90,
				});
			});
		});

		it("does not trigger sync when custom days input is not a valid number", async () => {
			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			const input = screen.getByPlaceholderText("Days");
			fireEvent.change(input, { target: { value: "abc" } });
			fireEvent.click(screen.getByText("Sync Range"));

			expect(mockSyncMutateAsync).not.toHaveBeenCalled();
		});

		it("does not trigger sync when custom days input is zero", async () => {
			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			const input = screen.getByPlaceholderText("Days");
			fireEvent.change(input, { target: { value: "0" } });
			fireEvent.click(screen.getByText("Sync Range"));

			expect(mockSyncMutateAsync).not.toHaveBeenCalled();
		});

		it("disables sync buttons while syncing", async () => {
			let resolveFetch!: (value: unknown) => void;
			mockSyncMutateAsync.mockResolvedValue({ jobId: "job-4" });
			mockSyncStatusFetch.mockImplementation(
				() => new Promise((resolve) => { resolveFetch = resolve; }),
			);

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			fireEvent.click(screen.getByText("Sync Last 7 Days"));

			await waitFor(() => {
				expect(mockSyncMutateAsync).toHaveBeenCalled();
			});

			const syncLast7Button = screen.getByText("Sync Last 7 Days").closest("button");
			const fullSyncButton = screen.getByText("Full Sync").closest("button");
			const syncRangeButton = screen.getByText("Sync Range").closest("button");

			expect(syncLast7Button).toHaveProperty("disabled", true);
			expect(fullSyncButton).toHaveProperty("disabled", true);
			expect(syncRangeButton).toHaveProperty("disabled", true);

			resolveFetch({
				status: "done",
				percentage: 100,
				providers: { wahoo: { status: "done", message: "Done" } },
			});
		});
	});

	describe("Disconnect", () => {
		it("renders disconnect button when provider is authorized", async () => {
			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			expect(screen.getByText("Disconnect Provider")).toBeTruthy();
		});

		it("does not render disconnect button when provider is not authorized", async () => {
			mockUseLocalSearchParams.mockReturnValue({ id: "strava" });
			mockProvidersQuery.mockReturnValue({ data: [unauthorizedProvider], isLoading: false });

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			expect(screen.queryByText("Disconnect Provider")).toBeNull();
		});

		it("shows Alert.alert with correct title when disconnect button is clicked", async () => {
			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			fireEvent.click(screen.getByText("Disconnect Provider"));

			expect(mockAlertFn).toHaveBeenCalledWith(
				"Disconnect Provider",
				expect.any(String),
				expect.arrayContaining([
					expect.objectContaining({ text: "Cancel", style: "cancel" }),
					expect.objectContaining({ text: "Disconnect", style: "destructive" }),
				]),
			);
		});

		it("calls disconnect mutation and navigates back when confirmed", async () => {
			mockDisconnectMutateAsync.mockResolvedValue({});

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			fireEvent.click(screen.getByText("Disconnect Provider"));

			const buttons = mockAlertFn.mock.calls[0][2] as Array<{ text: string; style: string; onPress?: () => Promise<void> }>;
			const disconnectButton = buttons.find((b) => b.text === "Disconnect");
			expect(disconnectButton).toBeDefined();

			await disconnectButton!.onPress?.();

			await waitFor(() => {
				expect(mockDisconnectMutateAsync).toHaveBeenCalledWith({ providerId: "wahoo" });
				expect(mockBack).toHaveBeenCalled();
			});
		});

		it("invalidates providers and providerStats after successful disconnect", async () => {
			mockDisconnectMutateAsync.mockResolvedValue({});

			const { default: ProviderDetailScreen } = await import("./[id]");
			render(<ProviderDetailScreen />);

			fireEvent.click(screen.getByText("Disconnect Provider"));

			const buttons = mockAlertFn.mock.calls[0][2] as Array<{ text: string; style: string; onPress?: () => Promise<void> }>;
			const disconnectButton = buttons.find((b) => b.text === "Disconnect");

			await disconnectButton!.onPress?.();

			await waitFor(() => {
				expect(mockInvalidateProviders).toHaveBeenCalled();
				expect(mockInvalidateProviderStats).toHaveBeenCalled();
			});
		});
	});
});
