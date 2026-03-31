import { createFileRoute } from "@tanstack/react-router";
import { InertialMeasurementUnitPage } from "../pages/InertialMeasurementUnitPage.tsx";

export const Route = createFileRoute("/inertial-measurement-unit")({
  component: InertialMeasurementUnitPage,
});
