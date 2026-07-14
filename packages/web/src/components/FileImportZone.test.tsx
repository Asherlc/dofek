// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileImportZone } from "./FileImportZone.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/strong-csv">{children}</a>,
}));

afterEach(cleanup);

describe("FileImportZone", () => {
  it("renders an explicit file picker button", () => {
    render(
      <FileImportZone
        providerId="strong-csv"
        title="Strong"
        description=".csv export from Strong app"
        accept=".csv"
        uploadUrl="/api/upload/strong-csv?units=kg"
        statusUrl="/api/upload/strong-csv/status"
      />,
    );

    expect(screen.getByRole("button", { name: "Import file" })).toBeTruthy();
    expect(screen.getByText(".csv export from Strong app")).toBeTruthy();
  });
});
