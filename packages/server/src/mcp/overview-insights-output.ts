import { z } from "zod";
import type { Insight } from "../insights/types.ts";
import { dateWindowStartString } from "../lib/date-window.ts";

/** The Overview card and its MCP tool share a fixed 90-day input. */
export const OVERVIEW_INSIGHTS_DAYS = 90;

const correlationSchema = z.strictObject({
  rho: z.number(),
  p_value: z.number(),
  n: z.number().int().nonnegative(),
});

const evidenceSchema = z.strictObject({
  relationship: z.enum(["descriptive_association", "correlation"]),
  label: z.string(),
  method: z.string(),
  observation_window: z.string().optional(),
  estimate_label: z.string().optional(),
});

const insightSchema = z.strictObject({
  id: z.string(),
  type: z.enum(["conditional", "correlation", "discovery"]),
  confidence: z.enum(["strong", "emerging", "early", "insufficient"]),
  action: z.string(),
  metric: z.string(),
  message: z.string(),
  detail: z.string(),
  effect_size: z.number(),
  p_value: z.number(),
  correlation: correlationSchema.optional(),
  explanation: z.string().optional(),
  confounders: z.array(z.string()).optional(),
  evidence: evidenceSchema.optional(),
});

/**
 * Read-only Overview insight summaries. Raw per-day points, distributions, and
 * grouped descriptive statistics are intentionally omitted; callers use the
 * identity, association, confidence, effect, p-value, and evidence fields.
 */
export const overviewInsightsOutputSchema = z.strictObject({
  result: z.strictObject({
    range: z.strictObject({
      start_date: z.string(),
      end_date: z.string(),
      timezone: z.string(),
      days: z.number().int(),
    }),
    insights: z.array(insightSchema),
  }),
});

/** Maps repository insights to the MCP wire shape, preserving candidate order. */
export function toOverviewInsightsOutput(input: {
  endDate: string;
  timezone: string;
  insights: Insight[];
}) {
  return {
    range: {
      start_date: dateWindowStartString(input.endDate, OVERVIEW_INSIGHTS_DAYS - 1),
      end_date: input.endDate,
      timezone: input.timezone,
      days: OVERVIEW_INSIGHTS_DAYS,
    },
    insights: input.insights.map((insight) => ({
      id: insight.id,
      type: insight.type,
      confidence: insight.confidence,
      action: insight.action,
      metric: insight.metric,
      message: insight.message,
      detail: insight.detail,
      effect_size: insight.effectSize,
      p_value: insight.pValue,
      ...(insight.correlation === undefined
        ? {}
        : {
            correlation: {
              rho: insight.correlation.rho,
              p_value: insight.correlation.pValue,
              n: insight.correlation.n,
            },
          }),
      ...(insight.explanation === undefined ? {} : { explanation: insight.explanation }),
      ...(insight.confounders === undefined ? {} : { confounders: insight.confounders }),
      ...(insight.evidence === undefined
        ? {}
        : {
            evidence: {
              relationship: insight.evidence.relationship,
              label: insight.evidence.label,
              method: insight.evidence.method,
              ...(insight.evidence.observationWindow === undefined
                ? {}
                : { observation_window: insight.evidence.observationWindow }),
              ...(insight.evidence.estimateLabel === undefined
                ? {}
                : { estimate_label: insight.evidence.estimateLabel }),
            },
          }),
    })),
  };
}
