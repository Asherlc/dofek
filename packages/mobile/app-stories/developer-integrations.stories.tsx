import type {
  DeveloperClientDetail,
  DeveloperClientSecret,
  DeveloperClientSummary,
} from "@dofek/auth/developer-clients";
import type { Meta, StoryObj } from "@storybook/react-native";
import type { ComponentProps } from "react";
import { Alert } from "react-native";
import { within } from "storybook/test";
import { DeveloperClientDetailScreenView } from "../app/developer-integrations/[clientId]";
import { DeveloperIntegrationsScreenView } from "../app/developer-integrations/index";

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

const activeDetail = {
  ...activeClient,
  redirectUris: ["https://integration.example/callback"],
} satisfies DeveloperClientDetail;

const revokedDetail = {
  ...activeDetail,
  status: "revoked",
} satisfies DeveloperClientDetail;

const rotatedCredential = {
  client: activeDetail,
  clientSecret: "example-placeholder-not-a-real-secret",
} satisfies DeveloperClientSecret;

const detailArgs = {
  actionError: null,
  detail: activeDetail,
  editError: null,
  error: null,
  isLoading: false,
  isRevoking: false,
  isRotating: false,
  isSaving: false,
  onDismissSecret: () => {},
  onEdit: () => {},
  onRevoke: () => {},
  onRotate: () => {},
  rotatedSecret: null,
} satisfies ComponentProps<typeof DeveloperClientDetailScreenView>;

const meta = {
  title: "Pages/Developer Integrations",
  component: DeveloperIntegrationsScreenView,
  args: {
    clients: [],
    createError: null,
    createdSecret: null,
    isCreating: false,
    isLoading: false,
    listError: null,
    onCreate: () => {},
    onDismissSecret: () => {},
    onOpenDetail: () => {},
    onOpenDocs: () => {},
  },
} satisfies Meta<typeof DeveloperIntegrationsScreenView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { clients: undefined, isLoading: true } };
export const Empty: Story = {};
export const QueryError: Story = {
  args: { clients: undefined, listError: new Error("Developer clients are unavailable") },
};
export const Active: Story = { args: { clients: [activeClient] } };
export const Revoked: Story = { args: { clients: [revokedClient] } };

export const DetailLoading: Story = {
  render: () => <DeveloperClientDetailScreenView {...detailArgs} detail={undefined} isLoading />,
};

export const DetailError: Story = {
  render: () => (
    <DeveloperClientDetailScreenView
      {...detailArgs}
      detail={undefined}
      error={new Error("Developer integration is unavailable")}
    />
  ),
};

export const DetailActive: Story = {
  render: () => <DeveloperClientDetailScreenView {...detailArgs} />,
};

export const DetailRevoked: Story = {
  render: () => <DeveloperClientDetailScreenView {...detailArgs} detail={revokedDetail} />,
};

export const DetailEdit: Story = {
  render: () => <DeveloperClientDetailScreenView {...detailArgs} />,
};

export const RotateConfirmation: Story = {
  render: () => (
    <DeveloperClientDetailScreenView
      {...detailArgs}
      onRotate={() =>
        Alert.alert(
          "Rotate client secret?",
          "The existing secret stops working immediately. Save the replacement before closing its one-time panel.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Rotate", style: "destructive" },
          ],
        )
      }
    />
  ),
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Rotate client secret" }),
    );
  },
};

export const OneTimeSecret: Story = {
  render: () => (
    <DeveloperClientDetailScreenView {...detailArgs} rotatedSecret={rotatedCredential} />
  ),
};

export const RevokeConfirmation: Story = {
  render: () => (
    <DeveloperClientDetailScreenView
      {...detailArgs}
      onRevoke={() =>
        Alert.alert(
          "Revoke developer integration?",
          "The client and all active grants stop working immediately. This cannot be undone.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Revoke", style: "destructive" },
          ],
        )
      }
    />
  ),
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Revoke developer integration" }),
    );
  },
};
