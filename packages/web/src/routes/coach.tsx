import { createFileRoute } from "@tanstack/react-router";
import { CoachPage } from "../pages/CoachPage.tsx";

export const Route = createFileRoute("/coach")({
  component: CoachPage,
});
