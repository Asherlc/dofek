import { describe, expect, it, vi } from "vitest";
import { selectScreenshotTab, waitForScreenshotReadiness } from "./screenshot-story-navigation";

describe("selectScreenshotTab", () => {
  it("clicks the exact requested tab before capture", async () => {
    const click = vi.fn(async () => {});
    const getAttribute = vi.fn(async () => "true");
    const and = vi.fn(() => ({ click, getAttribute, and }));
    const getByRole = vi.fn(and);
    const locator = vi.fn(and);
    const waitForFunction = vi.fn(async () => {});
    const getByText = vi.fn();

    await selectScreenshotTab({ getByRole, locator, waitForFunction, getByText }, "Data Sources");

    expect(getByRole).toHaveBeenCalledWith("button", { name: "Data Sources", exact: true });
    expect(locator).toHaveBeenCalledWith("[aria-selected]");
    expect(click).toHaveBeenCalledOnce();
    expect(getAttribute).toHaveBeenCalledWith("aria-selected");
    expect(click.mock.invocationCallOrder[0]).toBeLessThan(
      waitForFunction.mock.invocationCallOrder[0] ?? 0,
    );
    expect(waitForFunction.mock.invocationCallOrder[0]).toBeLessThan(
      getAttribute.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("rejects capture when the requested tab was not selected", async () => {
    const click = vi.fn(async () => {});
    const getAttribute = vi.fn(async () => "false");
    const and = vi.fn(() => ({ click, getAttribute, and }));
    const getByRole = vi.fn(and);
    const locator = vi.fn(and);
    const waitForFunction = vi.fn(async () => {});
    const getByText = vi.fn();

    await expect(
      selectScreenshotTab({ getByRole, locator, waitForFunction, getByText }, "Data Sources"),
    ).rejects.toThrow('Screenshot tab "Data Sources" was not selected');
  });

  it("does not look up a tab when the screenshot has no tab label", async () => {
    const getByRole = vi.fn(() => ({
      and: vi.fn(),
      click: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => "false"),
    }));
    const locator = vi.fn(getByRole);
    const waitForFunction = vi.fn(async () => {});
    const getByText = vi.fn();

    await selectScreenshotTab({ getByRole, locator, waitForFunction, getByText });

    expect(getByRole).not.toHaveBeenCalled();
    expect(waitForFunction).not.toHaveBeenCalled();
  });
});

describe("waitForScreenshotReadiness", () => {
  it("waits for the configured readiness text to become visible", async () => {
    const waitFor = vi.fn(async () => {});
    const getByText = vi.fn(() => ({
      first: () => ({ waitFor }),
    }));

    await waitForScreenshotReadiness(
      {
        getByRole: vi.fn(),
        locator: vi.fn(),
        waitForFunction: vi.fn(),
        getByText,
      },
      "LAST NIGHT",
    );

    expect(getByText).toHaveBeenCalledWith("LAST NIGHT", { exact: false });
    expect(waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
  });

  it("rejects an empty readiness anchor", async () => {
    await expect(
      waitForScreenshotReadiness(
        {
          getByRole: vi.fn(),
          locator: vi.fn(),
          waitForFunction: vi.fn(),
          getByText: vi.fn(),
        },
        "   ",
      ),
    ).rejects.toThrow("Screenshot readiness text is required");
  });
});
