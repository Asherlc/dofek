/**
 * Design tokens shared across web and iOS.
 *
 * Platform-agnostic values — no React, no HTML, no React Native.
 * Web uses these via Tailwind @theme + CSS. iOS uses them in StyleSheets.
 *
 * Colors live in ./colors.ts (separate module for historical reasons).
 */

// ── Typography ──

export const fontFamily = {
  /** Body text — Inter on web, system default on iOS until fonts load */
  body: "Inter",
  /** Monospace for numbers, metrics, code — DM Mono on web, Menlo on iOS */
  mono: "DM Mono",
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  base: 14,
  lg: 16,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 48,
} as const;

export const fontWeight = {
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800",
} as const;

// ── Animation ──

export const duration = {
  /** Micro-interactions: hover, press, toggle */
  fast: 150,
  /** Standard transitions: fade, slide */
  normal: 300,
  /** Content reveals: card appear, section expand */
  slow: 500,
  /** Count-up numbers */
  countUp: 800,
  /** Ring draw-in, chart bars grow */
  chart: 1200,
  /** Logo heartbeat cycle */
  heartbeat: 3000,
} as const;

export const easing = {
  /** Standard ease-out for most transitions */
  out: "cubic-bezier(0.16, 1, 0.3, 1)",
  /** Ease-in-out for looping animations */
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
  /** ECharts cubic out */
  echartsOut: "cubicOut",
} as const;

// ── Spacing ──

export const spacing = {
  /** Tight: between related items (icon + label) */
  xs: 4,
  /** Default gap between cards in a row */
  sm: 8,
  /** Section padding, card internal spacing */
  md: 16,
  /** Between dashboard sections */
  lg: 24,
  /** Page margins */
  xl: 32,
} as const;

// ── Border radius ──

export const radius = {
  /** Pill shapes, status dots */
  full: 9999,
  /** Cards, major containers */
  xl: 16,
  /** Secondary containers, modals */
  lg: 12,
  /** Buttons, inputs */
  md: 8,
  /** Small elements, badges */
  sm: 4,
} as const;

// ── Chart defaults ──
// Platform-agnostic chart configuration values.
// Web applies these to ECharts. iOS applies to SVG/canvas.

export const chart = {
  /** Default chart height in px */
  defaultHeight: 250,
  /** Stagger delay between bar animations (ms) */
  barStaggerDelay: 50,
  /** Grid padding defaults (px) */
  grid: {
    top: 30,
    right: 12,
    bottom: 30,
    left: 40,
  },
  /** Grid padding when chart has dual y-axes */
  gridDualAxis: {
    top: 30,
    right: 60,
    bottom: 30,
    left: 50,
  },
} as const;
