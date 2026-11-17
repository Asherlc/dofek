import { useRouter } from "expo-router";
import { NavigationMenu } from "../../components/NavigationMenu";

export default function MoreScreen() {
  const router = useRouter();
  return (
    <NavigationMenu
      groups={[
        [
          {
            title: "Body",
            subtitle: "Vitals, heart rate and body composition",
            onPress: () => router.push("/body"),
          },
          {
            title: "Nutrition",
            subtitle: "Daily log and analytics",
            onPress: () => router.push("/nutrition"),
          },
          {
            title: "Correlation",
            subtitle: "Explore pairs of measurements",
            onPress: () => router.push("/correlation"),
          },
        ],
        [
          { title: "Data Sources", onPress: () => router.push("/providers") },
          { title: "Settings", onPress: () => router.push("/settings") },
        ],
      ]}
    />
  );
}
