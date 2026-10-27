export const IOS_TESTFLIGHT_INVITE_URL = "https://testflight.apple.com/join/FXywHr9c";

export const IOS_TESTFLIGHT_INVITE = {
  title: "Get the iOS app",
  description:
    "Install Dofek on your iPhone or iPad through TestFlight to sync Apple Health and use mobile features.",
  actionLabel: "Open TestFlight invite",
  url: IOS_TESTFLIGHT_INVITE_URL,
} as const;

export interface GetStartedStep {
  id: "connect-sources" | "review-first-insight";
  title: string;
  description: string;
  actionLabel: string;
  webPath: string;
  mobilePath: string;
}

export const GET_STARTED_STEPS = [
  {
    id: "connect-sources",
    title: "Connect your sources",
    description: "Choose the apps and devices you already use so Dofek can start syncing data.",
    actionLabel: "Set up data sources",
    webPath: "/settings",
    mobilePath: "/providers",
  },
  {
    id: "review-first-insight",
    title: "Check your dashboard",
    description:
      "Once data is connected, the dashboard shows what is ready and what still needs time.",
    actionLabel: "Open dashboard",
    webPath: "/dashboard",
    mobilePath: "/(tabs)",
  },
] as const satisfies readonly GetStartedStep[];
