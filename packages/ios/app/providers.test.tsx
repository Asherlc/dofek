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
	TextInput: ({ placeholder, value, onChangeText, secureTextEntry, ...props }: Record<string, unknown>) => {
		const { style: _s, placeholderTextColor: _pc, keyboardType: _kt, autoCapitalize: _ac, autoCorrect: _acr, ...rest } = props;
		return React.createElement("input", {
			type: secureTextEntry ? "password" : "text",
			placeholder,
			value: value as string,
			onChange: (e: React.ChangeEvent<HTMLInputElement>) => (onChangeText as (text: string) => void)?.(e.target.value),
			...rest,
		});
	},
	Modal: ({ children, visible, onRequestClose, ...props }: Record<string, unknown>) => {
		if (!visible) return null;
		const { animationType: _at, transparent: _t, ...rest } = props;
		return React.createElement("div", { role: "dialog", ...rest }, children as React.ReactNode);
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

vi.mock("expo-web-browser", () => ({
	openBrowserAsync: vi.fn().mockResolvedValue({ type: "cancel" }),
}));

vi.mock("../lib/share-import", () => ({
	importSharedFile: vi.fn(),
}));

vi.mock("@dofek/format/format", () => ({
	formatRelativeTime: (date: string) => `${date} ago`,
}));

const mockProvidersQuery = vi.fn();
const mockStatsQuery = vi.fn();
const mockLogsQuery = vi.fn();
const mockActiveSyncsQuery = vi.fn();
const mockInvalidate = vi.fn();
const mockSyncStatusFetch = vi.fn();
const mockCredentialSignIn = vi.fn();

vi.mock("../lib/trpc", () => ({
	trpc: {
		sync: {
			providers: { useQuery: (...args: unknown[]) => mockProvidersQuery(...args) },
			providerStats: { useQuery: (...args: unknown[]) => mockStatsQuery(...args) },
			logs: { useQuery: (...args: unknown[]) => mockLogsQuery(...args) },
			triggerSync: { useMutation: () => ({ mutateAsync: mockSyncMutateAsync }) },
			activeSyncs: { useQuery: (...args: unknown[]) => mockActiveSyncsQuery(...args) },
		},
		credentialAuth: {
			signIn: { useMutation: () => ({ mutateAsync: mockCredentialSignIn }) },
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
	authType: "oauth",
	authorized: true,
	importOnly: false,
	lastSyncedAt: "2026-03-19T12:00:00Z",
};

const disconnectedProvider = {
	id: "strava",
	name: "Strava",
	authType: "oauth",
	authorized: false,
	importOnly: false,
	lastSyncedAt: null,
};

const credentialProvider = {
	id: "eight-sleep",
	name: "Eight Sleep",
	authType: "credential",
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

function makeProvider(overrides: Partial<{
	id: string;
	label: string;
	enabled: boolean;
	authStatus: "connected" | "not_connected" | "expired";
	authType: string;
	lastSyncAt: string | null;
}> = {}) {
	return {
		id: overrides.id ?? "wahoo",
		label: overrides.label ?? "Wahoo",
		enabled: overrides.enabled ?? true,
		authStatus: overrides.authStatus ?? "connected",
		authType: overrides.authType ?? "oauth",
		lastSyncAt: overrides.lastSyncAt ?? null,
		...overrides,
	};
}

const noopFn = () => {};

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

describe("ProviderCard", () => {
	describe("sync progress", () => {
		it("renders progress bar when syncing with percentage", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider()}
					stats={undefined}
					syncing={true}
					syncProgress={{ percentage: 45, message: "Fetching activities..." }}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.getByText("Fetching activities...")).toBeTruthy();
			expect(screen.queryByText("Connected")).toBeNull();
			expect(screen.queryByText("Never synced")).toBeNull();
		});

		it("renders progress message without percentage", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider()}
					stats={undefined}
					syncing={true}
					syncProgress={{ message: "Preparing sync..." }}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.getByText("Preparing sync...")).toBeTruthy();
		});

		it("renders progress bar without message when only percentage is provided", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider()}
					stats={undefined}
					syncing={true}
					syncProgress={{ percentage: 60 }}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.queryByText("Connected")).toBeNull();
			expect(screen.queryByText("Never synced")).toBeNull();
		});
	});

	describe("normal metadata when not syncing", () => {
		it("renders auth status and last sync time when not syncing", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider({ lastSyncAt: "2026-03-19T12:00:00Z" })}
					stats={undefined}
					syncing={false}
					syncProgress={undefined}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.getByText("Connected")).toBeTruthy();
			expect(screen.getByText(/Last sync:/)).toBeTruthy();
		});

		it("renders 'Never synced' when provider has no lastSyncAt", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider({ lastSyncAt: null })}
					stats={undefined}
					syncing={false}
					syncProgress={undefined}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.getByText("Connected")).toBeTruthy();
			expect(screen.getByText("Never synced")).toBeTruthy();
		});

		it("renders normal metadata when syncing but syncProgress is undefined", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider()}
					stats={undefined}
					syncing={true}
					syncProgress={undefined}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.getByText("Connected")).toBeTruthy();
			expect(screen.getByText("Never synced")).toBeTruthy();
		});

		it("renders 'Not connected' status for disconnected providers", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider({ authStatus: "not_connected" })}
					stats={undefined}
					syncing={false}
					syncProgress={undefined}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.getByText("Not connected")).toBeTruthy();
		});

		it("renders 'Expired' status for expired providers", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider({ authStatus: "expired" })}
					stats={undefined}
					syncing={false}
					syncProgress={undefined}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.getByText("Expired")).toBeTruthy();
		});
	});

	describe("progress percentage clamping", () => {
		it("renders without error when percentage is negative", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider()}
					stats={undefined}
					syncing={true}
					syncProgress={{ percentage: -20 }}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			// Should render the progress container, not the metadata
			expect(screen.queryByText("Connected")).toBeNull();
		});

		it("renders without error when percentage exceeds 100", async () => {
			const { ProviderCard } = await import("./providers");
			render(
				<ProviderCard
					provider={makeProvider()}
					stats={undefined}
					syncing={true}
					syncProgress={{ percentage: 150 }}
					onSync={noopFn}
					onFullSync={noopFn}
					onConnect={noopFn}
					onPress={noopFn}
				/>,
			);

			expect(screen.queryByText("Connected")).toBeNull();
		});
	});

	it("renders provider label", async () => {
		const { ProviderCard } = await import("./providers");
		render(
			<ProviderCard
				provider={makeProvider({ label: "Wahoo" })}
				stats={undefined}
				syncing={false}
				syncProgress={undefined}
				onSync={noopFn}
				onFullSync={noopFn}
				onPress={noopFn}
			/>,
		);

		expect(screen.getByText("Wahoo")).toBeTruthy();
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
		mockCredentialSignIn.mockReset();
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

	it("opens credential auth modal when Connect is clicked on a credential provider", async () => {
		mockProvidersQuery.mockReturnValue({
			data: [credentialProvider],
			isLoading: false,
		});

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		fireEvent.click(screen.getByText("Connect"));

		await waitFor(() => {
			expect(screen.getByText("Connect Eight Sleep")).toBeTruthy();
		});
	});

	it("credential auth modal calls signIn mutation with correct args", async () => {
		mockProvidersQuery.mockReturnValue({
			data: [credentialProvider],
			isLoading: false,
		});
		mockCredentialSignIn.mockResolvedValue({});

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		// Open the modal
		fireEvent.click(screen.getByText("Connect"));
		await waitFor(() => {
			expect(screen.getByText("Connect Eight Sleep")).toBeTruthy();
		});

		// Fill in credentials
		fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "user@test.com" } });
		fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "secret123" } });

		// Submit
		fireEvent.click(screen.getByText("Sign In"));

		await waitFor(() => {
			expect(mockCredentialSignIn).toHaveBeenCalledWith({
				providerId: "eight-sleep",
				username: "user@test.com",
				password: "secret123",
			});
		});
	});

	it("opens browser for OAuth provider connect", async () => {
		const WebBrowser = await import("expo-web-browser");
		mockProvidersQuery.mockReturnValue({
			data: [disconnectedProvider],
			isLoading: false,
		});

		const { default: ProvidersScreen } = await import("./providers");
		render(<ProvidersScreen />);

		fireEvent.click(screen.getByText("Connect"));

		await waitFor(() => {
			expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
				"https://test.example.com/auth/provider/strava",
			);
		});
	});
});
