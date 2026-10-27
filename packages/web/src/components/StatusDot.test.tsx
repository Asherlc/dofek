/** @vitest-environment jsdom */
import { operationalStatusColors, surfaceColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusDot } from "./StatusDot.tsx";

function relativeLuminance(hexColor: string): number {
  const linearChannel = (start: number) => {
    const channel = Number.parseInt(hexColor.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function compositeHex(foreground: string, background: string, alpha: number): string {
  const channel = (start: number) => {
    const foregroundChannel = Number.parseInt(foreground.slice(start, start + 2), 16);
    const backgroundChannel = Number.parseInt(background.slice(start, start + 2), 16);
    return Math.round(foregroundChannel * alpha + backgroundChannel * (1 - alpha));
  };
  return `#${[1, 3, 5]
    .map(channel)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("StatusDot", () => {
  it.each([
    ["idle", "Idle", "—", operationalStatusColors.neutral],
    ["syncing", "Syncing", "↻", operationalStatusColors.info],
    ["done", "Synced", "✓", operationalStatusColors.success],
    ["error", "Error", "!", operationalStatusColors.danger],
  ] as const)("renders %s with a visible label and symbol", (status, label, symbol, tone) => {
    render(<StatusDot status={status} />);

    const output = screen.getByRole("status", { name: `Status: ${label}` });
    expect(output.textContent).toContain(label);
    expect(output.textContent).toContain(symbol);
    expect(output).toHaveStyle({
      backgroundColor: tone.surface,
      borderColor: tone.border,
      color: tone.foreground,
    });
    expect(
      contrastRatio(compositeHex(tone.foreground, tone.surface, 1), tone.surface),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(compositeHex(tone.border, tone.surface, 1), tone.surface),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(compositeHex(tone.border, surfaceColors.surface, 1), surfaceColors.surface),
    ).toBeGreaterThanOrEqual(3);
  });
});
