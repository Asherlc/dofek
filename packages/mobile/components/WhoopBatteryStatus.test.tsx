import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WhoopBatteryStatus } from "./WhoopBatteryStatus";

describe("WhoopBatteryStatus", () => {
  it.each([
    [52.4, null, "52.4%", "Charging unknown"],
    [null, false, "Battery unavailable", "Not charging"],
  ] as const)(
    "presents independently reported battery facts",
    (percentage, isCharging, level, charging) => {
      render(<WhoopBatteryStatus percentage={percentage} isCharging={isCharging} />);

      expect(screen.getByText(level)).toBeTruthy();
      expect(screen.getByText(charging)).toBeTruthy();
    },
  );
});
