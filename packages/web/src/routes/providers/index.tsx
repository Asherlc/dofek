import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/providers/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings" });
  },
});
