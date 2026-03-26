import { createFileRoute } from "@tanstack/react-router";
import { AccelerometerPage } from "../pages/AccelerometerPage.tsx";

export const Route = createFileRoute("/accelerometer")({
  component: AccelerometerPage,
});
