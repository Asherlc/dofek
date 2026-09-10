import { createFileRoute } from "@tanstack/react-router";
import { ClinicalRecordDetailPage } from "../pages/clinical-records.tsx";

export const Route = createFileRoute("/clinical-records/$id")({
  component: ClinicalRecordDetailPage,
});
