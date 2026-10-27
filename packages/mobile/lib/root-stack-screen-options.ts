import { colors } from "../theme";

export const rootStackScreenOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  headerBackButtonDisplayMode: "minimal" as const,
  headerBackTitle: "Back",
  headerBackTitleVisible: false,
  headerShadowVisible: false,
  animation: "fade" as const,
};
