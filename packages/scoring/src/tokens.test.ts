import { describe, expect, it } from "vitest";
import {
  chart,
  duration,
  easing,
  fontFamily,
  fontSize,
  fontWeight,
  radius,
  spacing,
} from "./tokens.ts";

describe("fontFamily", () => {
  it("has body font set to Inter", () => {
    expect(fontFamily.body).toBe("Inter");
  });

  it("has mono font set to DM Mono", () => {
    expect(fontFamily.mono).toBe("DM Mono");
  });
});

describe("fontSize", () => {
  it("exports all size keys", () => {
    expect(fontSize.xs).toBe(11);
    expect(fontSize.sm).toBe(13);
    expect(fontSize.base).toBe(14);
    expect(fontSize.lg).toBe(16);
    expect(fontSize.xl).toBe(20);
    expect(fontSize["2xl"]).toBe(24);
    expect(fontSize["3xl"]).toBe(30);
    expect(fontSize["4xl"]).toBe(36);
    expect(fontSize["5xl"]).toBe(48);
  });

  it("all values are positive numbers", () => {
    for (const value of Object.values(fontSize)) {
      expect(value).toBeGreaterThan(0);
      expect(typeof value).toBe("number");
    }
  });

  it("values are in ascending order", () => {
    const ordered = [
      fontSize.xs,
      fontSize.sm,
      fontSize.base,
      fontSize.lg,
      fontSize.xl,
      fontSize["2xl"],
      fontSize["3xl"],
      fontSize["4xl"],
      fontSize["5xl"],
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1] ?? 0);
    }
  });
});

describe("fontWeight", () => {
  it("exports all weight keys as numeric strings", () => {
    expect(fontWeight.normal).toBe("400");
    expect(fontWeight.medium).toBe("500");
    expect(fontWeight.semibold).toBe("600");
    expect(fontWeight.bold).toBe("700");
    expect(fontWeight.extrabold).toBe("800");
  });

  it("all values are parseable as numbers between 100 and 900", () => {
    for (const value of Object.values(fontWeight)) {
      const num = Number(value);
      expect(num).toBeGreaterThanOrEqual(100);
      expect(num).toBeLessThanOrEqual(900);
    }
  });
});

describe("duration", () => {
  it("exports all duration keys as positive numbers", () => {
    expect(duration.fast).toBe(150);
    expect(duration.normal).toBe(300);
    expect(duration.slow).toBe(500);
    expect(duration.countUp).toBe(800);
    expect(duration.chart).toBe(1200);
    expect(duration.heartbeat).toBe(3000);
  });

  it("fast < normal < slow < countUp < chart < heartbeat", () => {
    expect(duration.fast).toBeLessThan(duration.normal);
    expect(duration.normal).toBeLessThan(duration.slow);
    expect(duration.slow).toBeLessThan(duration.countUp);
    expect(duration.countUp).toBeLessThan(duration.chart);
    expect(duration.chart).toBeLessThan(duration.heartbeat);
  });
});

describe("easing", () => {
  it("exports CSS cubic-bezier for out easing", () => {
    expect(easing.out).toMatch(/^cubic-bezier\(/);
  });

  it("exports CSS cubic-bezier for inOut easing", () => {
    expect(easing.inOut).toMatch(/^cubic-bezier\(/);
  });

  it("exports ECharts easing string for echartsOut", () => {
    expect(easing.echartsOut).toBe("cubicOut");
  });
});

describe("spacing", () => {
  it("exports all spacing keys", () => {
    expect(spacing.xs).toBe(4);
    expect(spacing.sm).toBe(8);
    expect(spacing.md).toBe(16);
    expect(spacing.lg).toBe(24);
    expect(spacing.xl).toBe(32);
  });

  it("values are in ascending order", () => {
    const ordered = [spacing.xs, spacing.sm, spacing.md, spacing.lg, spacing.xl];
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1] ?? 0);
    }
  });

  it("all values are positive multiples of 4", () => {
    for (const value of Object.values(spacing)) {
      expect(value).toBeGreaterThan(0);
      expect(value % 4).toBe(0);
    }
  });
});

describe("radius", () => {
  it("exports all radius keys", () => {
    expect(radius.full).toBe(9999);
    expect(radius.lg).toBe(12);
    expect(radius.md).toBe(8);
    expect(radius.sm).toBe(4);
  });

  it("full radius is suitable for pill shapes", () => {
    expect(radius.full).toBeGreaterThanOrEqual(9999);
  });

  it("sm < md < lg < full", () => {
    expect(radius.sm).toBeLessThan(radius.md);
    expect(radius.md).toBeLessThan(radius.lg);
    expect(radius.lg).toBeLessThan(radius.full);
  });
});

describe("chart", () => {
  it("has a default height of 250px", () => {
    expect(chart.defaultHeight).toBe(250);
  });

  it("has a positive bar stagger delay", () => {
    expect(chart.barStaggerDelay).toBe(50);
    expect(chart.barStaggerDelay).toBeGreaterThan(0);
  });

  describe("grid", () => {
    it("has standard grid padding", () => {
      expect(chart.grid).toEqual({
        top: 30,
        right: 12,
        bottom: 30,
        left: 40,
      });
    });

    it("all grid values are non-negative", () => {
      for (const value of Object.values(chart.grid)) {
        expect(value).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("gridDualAxis", () => {
    it("has dual-axis grid padding", () => {
      expect(chart.gridDualAxis).toEqual({
        top: 30,
        right: 60,
        bottom: 30,
        left: 50,
      });
    });

    it("has more right padding than standard grid for second y-axis", () => {
      expect(chart.gridDualAxis.right).toBeGreaterThan(chart.grid.right);
    });

    it("has more left padding than standard grid for wider labels", () => {
      expect(chart.gridDualAxis.left).toBeGreaterThan(chart.grid.left);
    });
  });
});
