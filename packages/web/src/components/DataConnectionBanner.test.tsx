/** @vitest-environment jsdom */
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataConnectionBanner } from "./DataConnectionBanner.tsx";

function renderBanner(queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DataConnectionBanner />
    </QueryClientProvider>,
  );
}

describe("DataConnectionBanner", () => {
  afterEach(() => {
    act(() => {
      onlineManager.setOnline(true);
    });
  });

  it("announces offline stale data and disables retry", () => {
    onlineManager.setOnline(false);

    renderBanner();

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "Offline — showing last available data where available. It may be stale until you reconnect.",
    );
    expect(banner).toHaveClass("fixed", "inset-x-0", "bottom-0", "z-50");
    const retryButton = screen.getByRole("button", { name: "Retry unavailable offline" });
    expect(retryButton).toHaveClass("bg-amber-50", "text-amber-950");
    expect(retryButton).toBeDisabled();
  });

  it("offers one manual retry for active failed queries", async () => {
    onlineManager.setOnline(true);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    let resolveRetry: ((value: { score: number }) => void) | undefined;
    const retryResult = new Promise<{ score: number }>((resolve) => {
      resolveRetry = resolve;
    });
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Server unavailable"))
      .mockReturnValueOnce(retryResult);
    const observer = new QueryObserver(queryClient, {
      queryKey: ["dashboard"],
      queryFn,
      initialData: { score: 82 },
      staleTime: 0,
    });
    const failed = new Promise<void>((resolve) => {
      observer.subscribe((result) => {
        if (result.error) {
          resolve();
        }
      });
    });

    renderBanner(queryClient);
    await act(async () => {
      await failed;
    });

    expect(queryClient.getQueryData(["dashboard"])).toEqual({ score: 82 });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Server unavailable — showing last available data where available.",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Retrying..." })).toBeDisabled();
    });
    const finishRetry = resolveRetry;
    if (!finishRetry) {
      throw new Error("Expected retry resolver");
    }
    await act(async () => {
      finishRetry({ score: 83 });
      await retryResult;
    });

    await waitFor(() => {
      expect(queryClient.getQueryData(["dashboard"])).toEqual({ score: 83 });
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("keeps retry available while an unrelated query is fetching", async () => {
    onlineManager.setOnline(true);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const failedObserver = new QueryObserver(queryClient, {
      queryKey: ["failed"],
      queryFn: async () => {
        throw new Error("Server unavailable");
      },
    });
    const failed = new Promise<void>((resolve) => {
      failedObserver.subscribe((result) => {
        if (result.error) {
          resolve();
        }
      });
    });
    const fetchingObserver = new QueryObserver(queryClient, {
      queryKey: ["still-fetching"],
      queryFn: () => new Promise(() => undefined),
    });
    const unsubscribeFetching = fetchingObserver.subscribe(() => undefined);

    renderBanner(queryClient);
    await act(async () => {
      await failed;
    });

    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(retryButton).toBeEnabled();

    unsubscribeFetching();
  });

  it("uses the consolidated message when multiple active queries fail", async () => {
    onlineManager.setOnline(true);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const firstObserver = new QueryObserver(queryClient, {
      queryKey: ["first-failed"],
      queryFn: async () => {
        throw new Error("First server message");
      },
    });
    const secondObserver = new QueryObserver(queryClient, {
      queryKey: ["second-failed"],
      queryFn: async () => {
        throw new Error("Second server message");
      },
    });
    const failures = Promise.all([
      new Promise<void>((resolve) => {
        firstObserver.subscribe((result) => {
          if (result.error) resolve();
        });
      }),
      new Promise<void>((resolve) => {
        secondObserver.subscribe((result) => {
          if (result.error) resolve();
        });
      }),
    ]);

    renderBanner(queryClient);
    await act(async () => {
      await failures;
    });

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "Data refresh failed — showing last available data where available.",
    );
    expect(banner).not.toHaveTextContent("First server message");
    expect(banner).not.toHaveTextContent("Second server message");
  });

  it("starts only one manual retry when the retry control is activated twice rapidly", async () => {
    onlineManager.setOnline(true);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const observer = new QueryObserver(queryClient, {
      queryKey: ["failed"],
      queryFn: async () => {
        throw new Error("Server unavailable");
      },
    });
    const failed = new Promise<void>((resolve) => {
      observer.subscribe((result) => {
        if (result.error) {
          resolve();
        }
      });
    });
    const retry = new Promise<void>(() => undefined);
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries").mockReturnValue(retry);

    renderBanner(queryClient);
    await act(async () => {
      await failed;
    });

    const retryButton = screen.getByRole("button", { name: "Retry" });
    act(() => {
      retryButton.click();
      retryButton.click();
    });

    expect(refetchQueries).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Retrying..." })).toBeDisabled();
  });
});
