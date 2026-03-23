import { createFileRoute } from "@tanstack/react-router";
import { SleepPage } from "../pages/SleepPage.tsx";

export const Route = createFileRoute("/sleep")({
  component: SleepPage,
});
