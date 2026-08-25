import type { DeveloperClientSummary } from "@dofek/auth/developer-clients";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DeveloperIntegrationsPageContent } from "./DeveloperIntegrationsPage.tsx";

const activeClient = {
  clientId: "ext_example_active",
  name: "Meal importer",
  scopes: ["nutrition:write"],
  status: "active",
  createdAt: "2026-08-20T18:00:00.000Z",
  lastRotatedAt: "2026-08-24T18:00:00.000Z",
} satisfies DeveloperClientSummary;

const revokedClient = {
  ...activeClient,
  clientId: "ext_example_revoked",
  name: "Retired importer",
  status: "revoked",
} satisfies DeveloperClientSummary;

const meta = {
  title: "Developer Integrations/List and Create",
  component: DeveloperIntegrationsPageContent,
  parameters: { layout: "fullscreen" },
  args: {
    clients: [],
    createError: null,
    createdSecret: null,
    isCreating: false,
    isLoading: false,
    listError: null,
    onCreate: () => {},
    onDismissSecret: () => {},
  },
} satisfies Meta<typeof DeveloperIntegrationsPageContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { clients: undefined, isLoading: true },
};

export const Empty: Story = {};

export const QueryError: Story = {
  args: { clients: undefined, listError: new Error("Developer clients are unavailable") },
};

export const Active: Story = {
  args: { clients: [activeClient] },
};

export const Revoked: Story = {
  args: { clients: [revokedClient] },
};
