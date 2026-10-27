import { describe, expect, it, vi } from "vitest";
import { selectScreenshotTab } from "./screenshot-story-navigation";

describe("selectScreenshotTab", () => {
  it("clicks the exact requested tab before capture", async () => {
    const click = vi.fn(async () => {});
    const getAttribute = vi.fn(async () => "true");
    const getByRole = vi.fn(() => ({ click, getAttribute }));
    const waitForFunction = vi.fn(async () => {});

    await selectScreenshotTab({ getByRole, waitForFunction }, "Connections");

    expect(getByRole).toHaveBeenCalledWith("button", { name: "Connections", exact: true });
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
    const getByRole = vi.fn(() => ({ click, getAttribute }));
    const waitForFunction = vi.fn(async () => {});

    await expect(
      selectScreenshotTab({ getByRole, waitForFunction }, "Connections"),
    ).rejects.toThrow('Screenshot tab "Connections" was not selected');
  });

  it("does not look up a tab when the screenshot has no tab label", async () => {
    const getByRole = vi.fn(() => ({
      click: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => "false"),
    }));
    const waitForFunction = vi.fn(async () => {});

    await selectScreenshotTab({ getByRole, waitForFunction });

    expect(getByRole).not.toHaveBeenCalled();
    expect(waitForFunction).not.toHaveBeenCalled();
  });
});
