import { createFileRoute } from "@tanstack/react-router";
import { BodyPage } from "../../pages/BodyPage.tsx";

export const Route = createFileRoute("/body/")({
  component: BodyPage,
});
