/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let cachedDate: string | null = null;
  let cachedData: { ftp: number | null; effectiveFrom: string } | null = null;
  return {
    settings: { data: { ftp: 259, effectiveFrom: "2026-10-01" }, error: null, isLoading: false },
    settingsLoading: false,
    settingsError: false,
    settingsErrorWithCachedData: false,
    history: {
      data: [
        { ftp: 259, effectiveFrom: "2026-10-01" },
        { ftp: null, effectiveFrom: "2026-09-01" },
      ],
      error: null,
      isLoading: false,
    },
    suggestions: {
      data: {
        methods: [
          {
            method: "reference_curves",
            suggested_ftp: 200,
            evidence: {
              activity_id: "ride-1",
              activity_name: "Threshold ride",
              date: "2026-11-03",
              duration_seconds: 1200,
              power_watts: 273,
            },
            limitations: "Estimate only.",
            unavailable_reason: null,
          },
          {
            method: "95_percent_best_20_minute",
            suggested_ftp: null,
            evidence: null,
            limitations: "Needs a qualifying effort.",
            unavailable_reason: "No qualifying effort in this date range.",
          },
        ],
      },
      error: null,
      isLoading: false,
    },
    getBySport: vi.fn(),
    historyQuery: vi.fn(),
    suggestionsQuery: vi.fn(),
    suggestionError: false,
    suggestionFetching: false,
    refetchSuggestions: vi.fn(),
    mutate: vi.fn(),
    upsertPending: false,
    onSuccess:
      vi.fn<
        (
          saved: { ftp: number | null; effectiveFrom: string },
          variables: { sport: "cycling"; ftp: number | null; effectiveFrom: string },
        ) => void
      >(),
    onError: vi.fn<(error: Error) => void>(),
    setData: vi.fn(
      (
        input: { sport: "cycling"; asOfDate: string },
        data: { ftp: number | null; effectiveFrom: string } | null,
      ) => {
        cachedDate = input.asOfDate;
        cachedData = data;
      },
    ),
    cachedSettings: (date: string) => (date === cachedDate ? cachedData : null),
    seedCachedSettings: (date: string, data: { ftp: number | null; effectiveFrom: string }) => {
      cachedDate = date;
      cachedData = data;
    },
    resetCachedSettings: () => {
      cachedDate = null;
      cachedData = null;
    },
    invalidations: {
      settings: vi.fn(),
      history: vi.fn(),
      powerZones: vi.fn(),
      pmc: vi.fn(),
      cycling: vi.fn(),
      calendar: vi.fn(),
    },
  };
});

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      sportSettings: {
        history: { invalidate: mocks.invalidations.history },
        getBySport: {
          invalidate: mocks.invalidations.settings,
          setData: mocks.setData,
        },
      },
      activity: { powerZones: { invalidate: mocks.invalidations.powerZones } },
      pmc: { invalidate: mocks.invalidations.pmc },
      cycling: { invalidate: mocks.invalidations.cycling },
      calendar: { invalidate: mocks.invalidations.calendar },
    }),
    sportSettings: {
      getBySport: { useQuery: mocks.getBySport },
      history: { useQuery: mocks.historyQuery },
      upsert: {
        useMutation: (options: {
          onSuccess: (
            saved: { ftp: number | null; effectiveFrom: string },
            variables: { sport: "cycling"; ftp: number | null; effectiveFrom: string },
          ) => void;
          onError: (error: Error) => void;
        }) => {
          mocks.onSuccess.mockImplementation(options.onSuccess);
          mocks.onError.mockImplementation(options.onError);
          return { mutate: mocks.mutate, isPending: mocks.upsertPending };
        },
      },
    },
    power: {
      ftpSuggestions: {
        useQuery: (
          input: { start_date: string; end_date: string },
          options: { enabled?: boolean },
        ) => {
          mocks.suggestionsQuery(input, options);
          return {
            ...mocks.suggestions,
            error: mocks.suggestionError ? new Error("Suggestions unavailable") : null,
            isFetching: mocks.suggestionFetching,
            refetch: mocks.refetchSuggestions,
          };
        },
      },
    },
  },
}));

vi.mock("../hooks/useTodayQueryDate.ts", () => ({ useTodayQueryDate: () => "2026-11-15" }));
vi.mock("../lib/telemetry.ts", () => ({ captureException: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {
    data: { ftp: 259, effectiveFrom: "2026-10-01" },
    error: null,
    isLoading: false,
  };
  mocks.settingsLoading = false;
  mocks.settingsError = false;
  mocks.settingsErrorWithCachedData = false;
  mocks.resetCachedSettings();
  mocks.history = {
    data: [
      { ftp: 259, effectiveFrom: "2026-10-01" },
      { ftp: null, effectiveFrom: "2026-09-01" },
    ],
    error: null,
    isLoading: false,
  };
  mocks.suggestions = {
    data: {
      methods: [
        {
          method: "reference_curves",
          suggested_ftp: 200,
          evidence: {
            activity_id: "ride-1",
            activity_name: "Threshold ride",
            date: "2026-11-03",
            duration_seconds: 1200,
            power_watts: 273,
          },
          limitations: "Estimate only.",
          unavailable_reason: null,
        },
        {
          method: "95_percent_best_20_minute",
          suggested_ftp: null,
          evidence: null,
          limitations: "Needs a qualifying effort.",
          unavailable_reason: "No qualifying effort in this date range.",
        },
      ],
    },
    error: null,
    isLoading: false,
  };
  mocks.suggestionError = false;
  mocks.suggestionFetching = false;
  mocks.upsertPending = false;
  mocks.refetchSuggestions.mockResolvedValue({ data: undefined });
  mocks.getBySport.mockImplementation((input: { asOfDate: string }) => ({
    data:
      mocks.settingsLoading || (mocks.settingsError && !mocks.settingsErrorWithCachedData)
        ? undefined
        : (mocks.cachedSettings(input.asOfDate) ??
          (input.asOfDate === "2026-09-01"
            ? { ftp: null, effectiveFrom: "2026-09-01" }
            : mocks.settings.data)),
    error: mocks.settingsError ? new Error("Settings unavailable") : null,
    isLoading: mocks.settingsLoading,
  }));
  mocks.historyQuery.mockImplementation(() => mocks.history);
});

afterEach(cleanup);

describe("CyclingFtpSettings", () => {
  it("loads the applicable value, lets the date and saved history be edited, and focuses a deep link", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    const { rerender } = render(<CyclingFtpSettings sectionDate="2026-11-10" focusSection />);

    const input = screen.getByRole("spinbutton", { name: "FTP watts" });
    expect(input).toHaveValue(259);
    expect(input).toHaveFocus();
    expect(screen.getByLabelText("Effective date")).toHaveValue("2026-11-10");

    fireEvent.change(input, { target: { value: "271" } });
    mocks.settings.data = { ftp: 260, effectiveFrom: "2026-10-01" };
    rerender(<CyclingFtpSettings sectionDate="2026-11-10" focusSection />);
    expect(screen.getByLabelText("FTP watts")).toHaveValue(271);

    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-01" } });
    await waitFor(() =>
      expect(mocks.getBySport).toHaveBeenLastCalledWith({
        sport: "cycling",
        asOfDate: "2026-09-01",
      }),
    );
    expect(screen.getByText("No FTP is set for this date.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Saved FTP dates"), {
      target: { value: "2026-10-01" },
    });
    await waitFor(() =>
      expect(mocks.getBySport).toHaveBeenLastCalledWith({
        sport: "cycling",
        asOfDate: "2026-10-01",
      }),
    );
    expect(screen.getByLabelText("Effective date")).toHaveValue("2026-10-01");
  });

  it("runs bounded suggestions only after Estimate, fills the input without writing, then saves explicitly", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    render(<CyclingFtpSettings />);

    expect(mocks.suggestionsQuery.mock.calls[0]).toEqual([
      { start_date: "2026-08-18", end_date: "2026-11-15" },
      { enabled: false },
    ]);
    expect(mocks.refetchSuggestions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(mocks.refetchSuggestions).toHaveBeenCalledOnce();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Unavailable: No qualifying effort in this date range.")).toBeVisible();

    fireEvent.click(await screen.findByRole("button", { name: "Use this value" }));
    expect(screen.getByLabelText("FTP watts")).toHaveValue(200);
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.invalidations.settings).not.toHaveBeenCalled();
    expect(mocks.invalidations.history).not.toHaveBeenCalled();
    expect(mocks.invalidations.powerZones).not.toHaveBeenCalled();
    expect(mocks.invalidations.pmc).not.toHaveBeenCalled();
    expect(mocks.invalidations.cycling).not.toHaveBeenCalled();
    expect(mocks.invalidations.calendar).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-11-10" } });
    expect(mocks.suggestionsQuery.mock.calls.at(-1)?.[0]).toEqual({
      start_date: "2026-08-01",
      end_date: "2026-11-10",
    });
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(mocks.refetchSuggestions).toHaveBeenCalledTimes(2);
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      sport: "cycling",
      ftp: 200,
      effectiveFrom: "2026-11-15",
    });
    act(() =>
      mocks.onSuccess(
        { ftp: 200, effectiveFrom: "2026-11-15" },
        { sport: "cycling", ftp: 200, effectiveFrom: "2026-11-15" },
      ),
    );
    expect(mocks.invalidations.settings).toHaveBeenCalledOnce();
    expect(mocks.invalidations.history).toHaveBeenCalledOnce();
    expect(mocks.invalidations.powerZones).toHaveBeenCalledOnce();
    expect(mocks.invalidations.pmc).toHaveBeenCalledOnce();
    expect(mocks.invalidations.cycling).toHaveBeenCalledOnce();
    expect(mocks.invalidations.calendar).toHaveBeenCalledOnce();
  });

  it("blocks suggestion changes until a pending save is acknowledged", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    const { rerender } = render(<CyclingFtpSettings />);

    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      sport: "cycling",
      ftp: 240,
      effectiveFrom: "2026-11-15",
    });

    mocks.upsertPending = true;
    rerender(<CyclingFtpSettings />);
    const useValueButton = screen.getByRole("button", { name: "Use this value" });
    expect(useValueButton).toBeDisabled();
    fireEvent.click(useValueButton);
    expect(screen.getByLabelText("FTP watts")).toHaveValue(240);
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.invalidations.settings).not.toHaveBeenCalled();
    expect(mocks.invalidations.history).not.toHaveBeenCalled();
    expect(mocks.invalidations.powerZones).not.toHaveBeenCalled();
    expect(mocks.invalidations.pmc).not.toHaveBeenCalled();
    expect(mocks.invalidations.cycling).not.toHaveBeenCalled();
    expect(mocks.invalidations.calendar).not.toHaveBeenCalled();

    mocks.upsertPending = false;
    act(() =>
      mocks.onSuccess(
        { ftp: 240, effectiveFrom: "2026-11-15" },
        { sport: "cycling", ftp: 240, effectiveFrom: "2026-11-15" },
      ),
    );
    expect(screen.getByLabelText("FTP watts")).toHaveValue(240);
    expect(mocks.invalidations.settings).toHaveBeenCalledOnce();
  });

  it("keeps the acknowledged FTP after a failed refresh and preserves later edits", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    mocks.seedCachedSettings("2026-11-15", { ftp: 259, effectiveFrom: "2026-10-01" });
    const { rerender } = render(<CyclingFtpSettings />);

    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saveVariables = { sport: "cycling" as const, ftp: 240, effectiveFrom: "2026-11-15" };
    act(() => mocks.onSuccess({ ftp: 240, effectiveFrom: "2026-11-15" }, saveVariables));

    mocks.settingsError = true;
    mocks.settingsErrorWithCachedData = true;
    rerender(<CyclingFtpSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("Settings unavailable");
    expect(screen.getByLabelText("FTP watts")).toHaveValue(240);

    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "230" } });
    rerender(<CyclingFtpSettings />);
    expect(screen.getByLabelText("FTP watts")).toHaveValue(230);
  });

  it("keeps the cleared value in the selected-date cache while the old response remains", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    mocks.seedCachedSettings("2026-11-15", { ftp: 259, effectiveFrom: "2026-10-01" });
    const { rerender } = render(<CyclingFtpSettings />);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    act(() =>
      mocks.onSuccess(
        { ftp: null, effectiveFrom: "2026-11-15" },
        { sport: "cycling", ftp: null, effectiveFrom: "2026-11-15" },
      ),
    );
    mocks.settingsError = true;
    mocks.settingsErrorWithCachedData = true;
    rerender(<CyclingFtpSettings />);

    expect(screen.getByLabelText("FTP watts")).toHaveValue(null);
    expect(screen.getByText("No FTP is set for this date.")).toBeVisible();
  });

  it("updates the mutation date cache without putting that value in a newly selected date", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    mocks.seedCachedSettings("2026-11-15", { ftp: 259, effectiveFrom: "2026-10-01" });
    const { rerender } = render(<CyclingFtpSettings sectionDate="2026-11-15" />);

    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    rerender(<CyclingFtpSettings sectionDate="2026-10-01" />);
    act(() =>
      mocks.onSuccess(
        { ftp: 240, effectiveFrom: "2026-11-15" },
        { sport: "cycling", ftp: 240, effectiveFrom: "2026-11-15" },
      ),
    );
    expect(screen.getByLabelText("FTP watts")).toHaveValue(259);

    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-11-15" } });
    await waitFor(() => expect(screen.getByLabelText("FTP watts")).toHaveValue(240));
  });

  it("shows estimate query failures as errors", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    mocks.suggestionError = true;
    render(<CyclingFtpSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Suggestions unavailable");
  });

  it("keeps cached suggestion evidence visible while refreshing the same date bounds", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(screen.getByText("Reference curves")).toBeVisible();

    mocks.suggestionFetching = true;
    rerender(<CyclingFtpSettings />);
    expect(screen.getByRole("status")).toHaveTextContent("Estimating from recorded activities");
    expect(screen.getByText("Reference curves")).toBeVisible();
    expect(screen.getByText(/Evidence: Threshold ride/)).toBeVisible();
    expect(screen.getByText("Estimate only.")).toBeVisible();
  });

  it("keeps cached suggestion evidence visible beside a same-bounds refresh error", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(screen.getByText("Reference curves")).toBeVisible();

    mocks.suggestionError = true;
    rerender(<CyclingFtpSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("Suggestions unavailable");
    expect(screen.getByText("Reference curves")).toBeVisible();
    expect(screen.getByText(/Evidence: Threshold ride/)).toBeVisible();
    expect(screen.getByText("Estimate only.")).toBeVisible();
  });

  it("rejects invalid watts and displays a save failure without losing the entry", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    render(<CyclingFtpSettings />);

    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("positive whole number");
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    act(() => mocks.onError(new Error("FTP could not be saved.")));
    expect(screen.getByRole("alert")).toHaveTextContent("FTP could not be saved.");
    expect(screen.getByLabelText("FTP watts")).toHaveValue(240);
  });

  it("clears with the selected effective date and keeps loading and errors distinct", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings.tsx");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      sport: "cycling",
      ftp: null,
      effectiveFrom: "2026-11-15",
    });

    mocks.settingsLoading = true;
    rerender(<CyclingFtpSettings />);
    expect(screen.getByText("Loading FTP settings…")).toBeVisible();
    mocks.settingsLoading = false;
    mocks.settingsError = true;
    rerender(<CyclingFtpSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("Settings unavailable");
  });
});
