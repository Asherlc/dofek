import { createFileRoute } from "@tanstack/react-router";
import { ZeppPairingPage } from "../pages/ZeppPairingPage.tsx";

function ZeppPairingRoute() {
  const { code } = Route.useSearch();
  return <ZeppPairingPage initialCode={code} />;
}

export const Route = createFileRoute("/zepp-pairing")({
  validateSearch: (search: Record<string, unknown>): { code?: string } => ({
    ...(typeof search.code === "string" && search.code.length > 0 ? { code: search.code } : {}),
  }),
  component: ZeppPairingRoute,
});
