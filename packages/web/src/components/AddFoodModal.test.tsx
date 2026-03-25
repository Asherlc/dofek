// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddFoodModal } from "./AddFoodModal.tsx";

const analyzeMutateMock = vi.fn();
const historyFetchMock = vi.fn().mockResolvedValue([]);

/** Stable reference returned by useUtils() so the useEffect dep array does not churn */
const stableUtils = {
  food: {
    search: {
      fetch: historyFetchMock,
    },
  },
};

function getInputByLabel(label: RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected input element for label: ${String(label)}`);
  }
  return element;
}

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    food: {
      analyzeWithAi: {
        useMutation: () => ({
          isPending: false,
          mutate: analyzeMutateMock,
        }),
      },
    },
    useUtils: () => stableUtils,
  },
}));

describe("AddFoodModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    historyFetchMock.mockClear().mockResolvedValue([]);
  });

  it("shows history results from tRPC search when typing", async () => {
    historyFetchMock.mockResolvedValue([
      {
        food_name: "Chicken Breast",
        food_description: "6 oz grilled",
        category: "meat",
        calories: 280,
        protein_g: 53,
        carbs_g: 0,
        fat_g: 6,
        fiber_g: 0,
        number_of_units: 1,
      },
    ]);

    render(<AddFoodModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/What did you eat\?/i), {
      target: { value: "chicken" },
    });

    await waitFor(() => {
      expect(historyFetchMock).toHaveBeenCalledWith({ query: "chicken", limit: 8 });
    });

    const suggestion = await screen.findByText("Chicken Breast");
    expect(screen.getByText("Your History")).toBeTruthy();

    fireEvent.click(suggestion);

    expect(getInputByLabel(/What did you eat\?/i).value).toBe("Chicken Breast");
    expect(getInputByLabel(/Calories/i).value).toBe("280");
    expect(getInputByLabel(/Serving description/i).value).toBe("6 oz grilled");
    expect(getInputByLabel(/Protein \(g\)/i).value).toBe("53");
    expect(getInputByLabel(/Carbs \(g\)/i).value).toBe("0");
    expect(getInputByLabel(/Fat \(g\)/i).value).toBe("6");
  });

  it("closes when Escape is pressed while an input is focused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onClose = vi.fn();
    render(<AddFoodModal isOpen onClose={onClose} onSubmit={vi.fn()} />);

    // Focus the food name input and press Escape
    const input = screen.getByLabelText(/What did you eat\?/i);
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows Open Food Facts results when Search Food Database button is clicked", async () => {
    historyFetchMock.mockResolvedValue([]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            code: "10",
            product_name: "Burger aux graines",
            product_name_en: "Seeded Burger Buns",
            brands: "Baker Co",
            lang: "en",
            serving_size: "1 bun (70g)",
            nutriments: {
              "energy-kcal_100g": 300,
              proteins_100g: 10,
              carbohydrates_100g: 42,
              fat_100g: 8,
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddFoodModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/What did you eat\?/i), {
      target: { value: "burger" },
    });

    // Wait for the "Search Food Database" button to appear (query >= 2 chars)
    const searchButton = await screen.findByText("Search Food Database");
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const suggestion = await screen.findByText("Seeded Burger Buns (Baker Co)");
    expect(screen.getByText("Food Database")).toBeTruthy();

    fireEvent.click(suggestion);

    // Find the localized search call (with country filter)
    const localizedCall = fetchMock.mock.calls.find((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("countries_tags_en") !== null;
    });
    expect(localizedCall).toBeDefined();
    const parsedUrl = new URL(String(localizedCall?.[0]));
    expect(parsedUrl.searchParams.get("lc")).toBe("en");
    expect(parsedUrl.searchParams.get("countries_tags_en")).toBe("united-states");

    expect(getInputByLabel(/What did you eat\?/i).value).toBe("Seeded Burger Buns (Baker Co)");
    expect(getInputByLabel(/Calories/i).value).toBe("300");
    expect(getInputByLabel(/Serving description/i).value).toBe("1 bun (70g)");
    expect(getInputByLabel(/Protein \(g\)/i).value).toBe("10");
    expect(getInputByLabel(/Carbs \(g\)/i).value).toBe("42");
    expect(getInputByLabel(/Fat \(g\)/i).value).toBe("8");
  });
});
