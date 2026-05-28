export type GetStartedGoalId = "training" | "recovery" | "nutrition" | "full-picture";

export interface GetStartedGoal {
  id: GetStartedGoalId;
  title: string;
  description: string;
}

export interface GetStartedStep {
  id: "choose-goal" | "connect-sources" | "set-up-mobile" | "review-first-insight";
  title: string;
  description: string;
  actionLabel: string;
  webPath: string;
  mobilePath: string;
}

export const GET_STARTED_GOALS = [
  {
    id: "training",
    title: "Understand training",
    description: "Connect workouts and review load, recovery, and performance trends together.",
  },
  {
    id: "recovery",
    title: "Improve recovery",
    description: "Bring sleep, resting heart rate, and readiness signals into one place.",
  },
  {
    id: "nutrition",
    title: "Track nutrition",
    description: "Log meals and compare food timing with sleep, training, and body trends.",
  },
  {
    id: "full-picture",
    title: "Compare all my health data",
    description: "Start with the sources you use most, then add more context over time.",
  },
] as const satisfies readonly GetStartedGoal[];

export const GET_STARTED_STEPS = [
  {
    id: "choose-goal",
    title: "Choose your focus",
    description: "Pick the first question you want Dofek to help answer.",
    actionLabel: "Choose a goal",
    webPath: "/onboarding",
    mobilePath: "/onboarding",
  },
  {
    id: "connect-sources",
    title: "Connect your data sources",
    description: "Add the health, training, nutrition, and body sources you already use.",
    actionLabel: "Set up data sources",
    webPath: "/settings",
    mobilePath: "/providers",
  },
  {
    id: "set-up-mobile",
    title: "Set up the iPhone app",
    description: "Use mobile sync for Apple Health, direct capture, and quick nutrition logging.",
    actionLabel: "Review mobile setup",
    webPath: "/settings",
    mobilePath: "/settings",
  },
  {
    id: "review-first-insight",
    title: "Review your first insight",
    description: "Open the dashboard to see what is ready and what needs more data.",
    actionLabel: "Open dashboard",
    webPath: "/dashboard",
    mobilePath: "/(tabs)",
  },
] as const satisfies readonly GetStartedStep[];
