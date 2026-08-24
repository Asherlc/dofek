/** @vitest-environment jsdom */

import type { DeveloperClientSecret } from "@dofek/auth/developer-clients";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeveloperClientSecretPanel } from "./DeveloperClientSecretPanel";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  setStringAsync: vi.fn(),
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock("../lib/telemetry", () => ({ captureException: mocks.captureException }));

const credential = {
  client: {
    clientId: "ext_mobile",
    name: "Mobile importer",
    redirectUris: ["https://client.example/callback"],
    scopes: ["nutrition:write"],
    status: "active",
    createdAt: "2026-08-24T20:00:00.000Z",
    lastRotatedAt: "2026-08-24T20:00:00.000Z",
  },
  clientSecret: "raw-mobile-secret",
} satisfies DeveloperClientSecret;

describe("DeveloperClientSecretPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.setStringAsync.mockReset();
    mocks.setStringAsync.mockResolvedValue(undefined);
  });

  it("shows the client ID and unrecoverable raw secret once", () => {
    render(<DeveloperClientSecretPanel secret={credential} onDismiss={vi.fn()} />);

    expect(screen.getByText("ext_mobile")).toBeTruthy();
    expect(screen.getByText("raw-mobile-secret")).toBeTruthy();
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy();
  });

  it("copies the ID and secret independently", async () => {
    render(<DeveloperClientSecretPanel secret={credential} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy client ID" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy client secret" }));

    await waitFor(() =>
      expect(mocks.setStringAsync.mock.calls).toEqual([["ext_mobile"], ["raw-mobile-secret"]]),
    );
  });

  it("reports clipboard failures without reporting credential values", async () => {
    const clipboardError = new Error("Clipboard permission denied");
    mocks.setStringAsync.mockRejectedValue(clipboardError);
    render(<DeveloperClientSecretPanel secret={credential} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy client secret" }));

    expect(
      await screen.findByText("Copy failed. Select and copy the value manually."),
    ).toBeTruthy();
    expect(mocks.captureException).toHaveBeenCalledWith(clipboardError, {
      source: "developer-client-copy",
    });
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("raw-mobile-secret");
  });

  it("asks the screen to clear the credential when dismissed", () => {
    const onDismiss = vi.fn();
    render(<DeveloperClientSecretPanel secret={credential} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
