/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeveloperClientForm } from "./DeveloperClientForm.tsx";

describe("DeveloperClientForm", () => {
  afterEach(cleanup);

  it("starts with one required redirect and the fixed least-privilege scope", () => {
    render(<DeveloperClientForm onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Integration name" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Redirect URI 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove redirect URI 1" })).toHaveProperty(
      "disabled",
      true,
    );
    const scope = screen.getByRole("checkbox", { name: "nutrition:write" });
    expect(scope).toHaveProperty("checked", true);
    expect(scope).toHaveProperty("disabled", true);
  });

  it("adds and removes redirect inputs while preserving at least one", () => {
    render(<DeveloperClientForm onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Add redirect URI" }));
    expect(screen.getByRole("textbox", { name: "Redirect URI 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove redirect URI 1" }));
    expect(screen.queryByRole("textbox", { name: "Redirect URI 2" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Redirect URI 1" })).toBeTruthy();
  });

  it("submits the trimmed name and canonical redirect set", () => {
    const onSubmit = vi.fn();
    render(<DeveloperClientForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Integration name" }), {
      target: { value: "  Meal importer  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 1" }), {
      target: { value: "https://client.example" },
    });

    fireEvent.submit(screen.getByRole("form", { name: "Developer integration" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Meal importer",
      redirectUris: ["https://client.example/"],
      scopes: ["nutrition:write"],
    });
  });

  it.each([
    ["HTTP", "http://client.example/callback", "Redirect URIs must use HTTPS."],
    ["fragment", "https://client.example/callback#fragment", /fragment/],
    ["credentials", "https://user:pass@client.example/callback", /credentials/],
    ["malformed", "not a uri", /Invalid URL|valid HTTPS redirect URI/],
  ])("shows the shared validation message for a %s redirect", (_label, value, message) => {
    render(<DeveloperClientForm onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Integration name" }), {
      target: { value: "Meal importer" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 1" }), {
      target: { value },
    });

    fireEvent.submit(screen.getByRole("form", { name: "Developer integration" }));

    expect(screen.getByText(message)).toBeTruthy();
  });

  it("shows the shared duplicate-canonical-URI message", () => {
    render(<DeveloperClientForm onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Integration name" }), {
      target: { value: "Meal importer" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 1" }), {
      target: { value: "https://client.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add redirect URI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Redirect URI 2" }), {
      target: { value: "https://client.example/" },
    });

    fireEvent.submit(screen.getByRole("form", { name: "Developer integration" }));

    expect(screen.getByText("Redirect URIs must be unique.")).toBeTruthy();
  });
});
