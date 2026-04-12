import { createFileRoute } from "@tanstack/react-router";
import { DailyHeartRatePage } from "../../pages/DailyHeartRatePage.tsx";

export const Route = createFileRoute("/training/heart-rate")({
  component: DailyHeartRatePage,
});
