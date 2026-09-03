import { createFileRoute } from "@tanstack/react-router";
import { ClinicalRecordsPage } from "../../pages/clinical-records.tsx";

export const Route = createFileRoute("/clinical-records/")({
  component: ClinicalRecordsPage,
});
