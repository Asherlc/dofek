/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({ id: "00000000-0000-0000-0000-000000000001" }));
const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  list: vi.fn(),
  push: vi.fn(),
}));

function withoutNativeProps(props: Record<string, unknown>) {
  const {
    accessibilityLiveRegion: _accessibilityLiveRegion,
    accessibilityState: _accessibilityState,
    activeOpacity: _activeOpacity,
    contentContainerStyle: _contentContainerStyle,
    importantForAccessibility: _importantForAccessibility,
    minHeight: _minHeight,
    style: _style,
    testID,
    ...domProps
  } = props;
  return { ...domProps, "data-testid": testID };
}

vi.mock("react-native", () => ({
  ActivityIndicator: () => React.createElement("span", null, "Loading"),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    children,
    onPress,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        ...withoutNativeProps(props),
        "aria-label": accessibilityLabel,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      },
      children,
    ),
  ScrollView: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", withoutNativeProps(props), children),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
    hairlineWidth: 1,
  },
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("span", withoutNativeProps(props), children),
  TouchableOpacity: ({
    accessibilityLabel,
    accessibilityRole,
    children,
    disabled,
    onPress,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        ...withoutNativeProps(props),
        "aria-label": accessibilityLabel,
        disabled,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      },
      children,
    ),
  View: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", withoutNativeProps(props), children),
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => routeState,
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    clinicalRecords: {
      detail: { useQuery: mocks.detail },
      list: { useQuery: mocks.list },
    },
  },
}));

import ClinicalRecordDetailScreen from "../app/clinical-record/[id]";
import ClinicalRecordsScreen from "../app/clinical-records";

const summary = {
  id: routeState.id,
  clinicalType: "labResult",
  typeLabel: "Lab result from server",
  displayName: "Wellness panel",
  sourceName: "Review Clinic",
  sourceLabel: "Demo data — synthetic",
  date: "2026-08-28T18:00:00.000Z",
  dateLabel: "Recorded 28 Aug 2026",
  downloadedAt: "2026-08-29T18:00:00.000Z",
  recordedAt: "2026-08-28T18:00:00.000Z",
  issuedAt: null,
} as const;

const detail = {
  ...summary,
  providerId: "apple_health",
  externalId: "review-lab-result",
  fhirVersion: "4.0.1",
  fhir: { resourceType: "Observation", status: "final" },
} as const;

function queryResult<T>(data?: T, overrides: Record<string, unknown> = {}) {
  return {
    data,
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

describe("ClinicalRecordsScreen", () => {
  beforeEach(() => {
    mocks.detail.mockReset();
    mocks.list.mockReset();
    mocks.push.mockReset();
    mocks.list.mockReturnValue(queryResult({ records: [summary], nextOffset: null }));
    mocks.detail.mockReturnValue(queryResult(detail));
  });

  afterEach(cleanup);

  it("renders server-authored record labels and opens detail", () => {
    render(<ClinicalRecordsScreen />);

    expect(screen.getByText("Lab result from server")).toBeTruthy();
    expect(screen.getByText("Demo data — synthetic")).toBeTruthy();
    expect(screen.getByText("Recorded 28 Aug 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Wellness panel" }));
    expect(mocks.push).toHaveBeenCalledWith(`/clinical-record/${summary.id}`);
  });

  it("keeps loading, server error, and empty responses distinct", () => {
    mocks.list.mockReturnValue(queryResult(undefined, { isLoading: true }));
    const loading = render(<ClinicalRecordsScreen />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    loading.unmount();

    mocks.list.mockReturnValue(
      queryResult(undefined, { error: new Error("Clinical data is unavailable.") }),
    );
    const error = render(<ClinicalRecordsScreen />);
    expect(screen.getByText("Clinical data is unavailable.")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
    error.unmount();

    mocks.list.mockReturnValue(queryResult({ records: [], nextOffset: null }));
    render(<ClinicalRecordsScreen />);
    expect(screen.getByTestId("query-state-empty").textContent).toContain(
      "No clinical records have been synced yet.",
    );
  });

  it("shows a cached-empty refetch error instead of the empty state", () => {
    mocks.list.mockReturnValue(
      queryResult(
        { records: [], nextOffset: null },
        { error: new Error("Clinical refresh is unavailable.") },
      ),
    );

    render(<ClinicalRecordsScreen />);

    expect(screen.getByText("Clinical refresh is unavailable.")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
  });

  it("pages with server-provided offsets", () => {
    mocks.list.mockReturnValue(queryResult({ records: [summary], nextOffset: 20 }));
    render(<ClinicalRecordsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(mocks.list).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });
  });
});

describe("ClinicalRecordDetailScreen", () => {
  beforeEach(() => {
    mocks.detail.mockReset();
    mocks.list.mockReset();
    mocks.detail.mockReturnValue(queryResult(detail));
  });

  afterEach(cleanup);

  it("renders server-authored detail labels and read-only FHIR JSON", () => {
    render(<ClinicalRecordDetailScreen />);

    expect(screen.getByText("Wellness panel")).toBeTruthy();
    expect(screen.getByText("Lab result from server")).toBeTruthy();
    expect(screen.getByText("Demo data — synthetic")).toBeTruthy();
    expect(screen.getByText("Recorded 28 Aug 2026")).toBeTruthy();
    expect(screen.getByText("FHIR resource")).toBeTruthy();
    expect(screen.getByText(/"resourceType": "Observation"/)).toBeTruthy();
  });

  it("shows the specific detail server error", () => {
    mocks.detail.mockReturnValue(
      queryResult(undefined, { error: new Error("Clinical record not found.") }),
    );

    render(<ClinicalRecordDetailScreen />);

    expect(screen.getByText("Clinical record not found.")).toBeTruthy();
  });
});
