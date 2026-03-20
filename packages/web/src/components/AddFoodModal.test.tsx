// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddFoodModal } from "./AddFoodModal.tsx";

const analyzeMutateMock = vi.fn();

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
  },
}));

describe("AddFoodModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows Open Food Facts suggestions and applies selected nutrition details", async () => {
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

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const suggestion = await screen.findByText("Seeded Burger Buns (Baker Co)");
    fireEvent.click(suggestion);

    const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    const parsedUrl = new URL(requestedUrl);
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
