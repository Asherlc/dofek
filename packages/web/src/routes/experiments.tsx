import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PersonalExperimentsPage } from "../pages/PersonalExperimentsPage.tsx";

const searchSchema = z.object({
  outcomeMetricId: z.string().optional(),
  lagDays: z.coerce.number().int().min(0).max(7).optional(),
});

export const Route = createFileRoute("/experiments")({
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = searchSchema.safeParse(search);
    return parsed.success ? parsed.data : {};
  },
  component: ExperimentsRoute,
});

function ExperimentsRoute() {
  const search = Route.useSearch();
  return <PersonalExperimentsPage search={search} />;
}
