import { createFileRoute } from "@tanstack/react-router";
import { AccountDeletionStatusPage } from "../pages/AccountDeletionStatusPage.tsx";

export const Route = createFileRoute("/account-deletion")({
  component: AccountDeletionStatusPage,
});
