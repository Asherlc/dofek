import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { within } from "storybook/test";
import LoginScreen from "../app/login";

type ProvidersResponse =
  | "error"
  | "loading"
  | {
      identity: string[];
      data: string[];
      password?: boolean;
    };

function installProvidersFetch(providersResponse: ProvidersResponse): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input.toString();
    if (new URL(requestUrl, "http://localhost").pathname !== "/api/auth/providers") {
      return previousFetch(input, init);
    }
    if (providersResponse === "loading") {
      return new Promise<Response>(() => {});
    }
    if (providersResponse === "error") {
      return new Response(null, { status: 503, statusText: "Service Unavailable" });
    }
    return new Response(JSON.stringify(providersResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function LoginStoryFrame() {
  return (
    <View style={{ flex: 1, backgroundColor: "#eef3ed" }}>
      <LoginScreen />
    </View>
  );
}

const meta = {
  title: "Pages/Login",
  component: LoginScreen,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof LoginScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  beforeEach: () =>
    installProvidersFetch({
      identity: ["google", "apple"],
      data: [],
      password: true,
    }),
  render: () => <LoginStoryFrame />,
};

export const CreateAccount: Story = {
  beforeEach: () =>
    installProvidersFetch({
      identity: [],
      data: [],
      password: true,
    }),
  render: () => <LoginStoryFrame />,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Create account" }),
    );
  },
};

export const InvalidRegistration: Story = {
  beforeEach: () =>
    installProvidersFetch({
      identity: [],
      data: [],
      password: true,
    }),
  render: () => <LoginStoryFrame />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Create account" }));
    await userEvent.type(canvas.getByLabelText("Email"), "not-an-email");
    await userEvent.type(canvas.getByLabelText("Password"), "short");
    const submitButton = canvas.getAllByRole("button", { name: "Create account" }).at(-1);
    if (!submitButton) throw new Error("Registration submit button not found");
    await userEvent.click(submitButton);
  },
};

export const Loading: Story = {
  beforeEach: () => installProvidersFetch("loading"),
  render: () => <LoginStoryFrame />,
};

export const Empty: Story = {
  beforeEach: () => installProvidersFetch({ identity: [], data: [] }),
  render: () => <LoginStoryFrame />,
};

export const ErrorState: Story = {
  name: "Error",
  beforeEach: () => installProvidersFetch("error"),
  render: () => <LoginStoryFrame />,
};
