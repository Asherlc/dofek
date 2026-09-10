/** @vitest-environment jsdom */

import type { DeveloperClientSecret } from "@dofek/auth/developer-clients";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeveloperClientSecretDialog } from "./DeveloperClientSecretDialog.tsx";

const mocks = vi.hoisted(() => ({ captureException: vi.fn(), writeText: vi.fn() }));

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));

const credential = {
  client: {
    clientId: "ext_dialog",
    name: "Dialog client",
    redirectUris: ["https://client.example/callback"],
    scopes: ["nutrition:write"],
    status: "active",
    createdAt: "2026-08-24T20:00:00.000Z",
    lastRotatedAt: "2026-08-24T20:00:00.000Z",
  },
  clientSecret: "raw-dialog-secret",
} satisfies DeveloperClientSecret;

function Harness() {
  const [secret, setSecret] = useState<DeveloperClientSecret | null>(credential);
  return <DeveloperClientSecretDialog secret={secret} onDismiss={() => setSecret(null)} />;
}

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

describe("DeveloperClientSecretDialog", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.writeText.mockReset();
    mocks.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
  });

  it("shows the client ID and unrecoverable raw secret once", () => {
    render(<Harness />);

    expect(screen.getByText("ext_dialog")).toBeTruthy();
    expect(screen.getByText("raw-dialog-secret")).toBeTruthy();
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy();
  });

  it("copies the ID and secret independently", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Copy client ID" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy client secret" }));

    await waitFor(() =>
      expect(mocks.writeText.mock.calls).toEqual([["ext_dialog"], ["raw-dialog-secret"]]),
    );
  });

  it("reports clipboard failures without reporting credential values", async () => {
    const clipboardError = new Error("Clipboard permission denied");
    mocks.writeText.mockRejectedValue(clipboardError);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Copy client secret" }));

    expect(
      await screen.findByText("Copy failed. Select and copy the value manually."),
    ).toBeTruthy();
    expect(mocks.captureException).toHaveBeenCalledWith(clipboardError, {
      source: "developer-client-copy",
    });
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("raw-dialog-secret");
  });

  it("does not carry a copy failure into a replacement credential", async () => {
    mocks.writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    const onDismiss = vi.fn();
    const { rerender } = render(
      <DeveloperClientSecretDialog secret={credential} onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy client secret" }));
    expect(
      await screen.findByText("Copy failed. Select and copy the value manually."),
    ).toBeTruthy();

    rerender(
      <DeveloperClientSecretDialog
        secret={{
          client: { ...credential.client, clientId: "ext_replacement" },
          clientSecret: "raw-replacement-secret",
        }}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("raw-replacement-secret")).toBeTruthy();
    expect(screen.queryByText("Copy failed. Select and copy the value manually.")).toBeNull();
  });

  it("ignores a late copy failure after the credential is dismissed", async () => {
    const clipboardWrite = deferred<void>();
    mocks.writeText.mockReturnValueOnce(clipboardWrite.promise);
    const onDismiss = vi.fn();
    const { rerender } = render(
      <DeveloperClientSecretDialog secret={credential} onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy client secret" }));
    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));
    rerender(<DeveloperClientSecretDialog secret={null} onDismiss={onDismiss} />);
    await act(async () => clipboardWrite.reject(new Error("Late clipboard failure")));
    rerender(<DeveloperClientSecretDialog secret={credential} onDismiss={onDismiss} />);

    expect(screen.queryByText("Copy failed. Select and copy the value manually.")).toBeNull();
  });

  it("clears the parent-held credential when dismissed", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "I saved the secret" }));

    expect(screen.queryByText("raw-dialog-secret")).toBeNull();
    expect(screen.queryByText("ext_dialog")).toBeNull();
  });
});
