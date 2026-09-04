import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ZeppPairingPage } from "../pages/ZeppPairingPage.tsx";

const zeppPairingSearchSchema = z.object({ code: z.string().min(1).optional() });

function ZeppPairingRoute() {
  const { code } = Route.useSearch();
  return <ZeppPairingPage initialCode={code} />;
}

export const Route = createFileRoute("/zepp-pairing")({
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    const parsed = zeppPairingSearchSchema.safeParse(search);
    return parsed.success ? parsed.data : {};
  },
  component: ZeppPairingRoute,
});
