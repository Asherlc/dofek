import { useRouter } from "expo-router";
import { NavigationMenu } from "../../components/NavigationMenu";
import { trainingSections } from "../../lib/training-sections";

export default function TrainingScreen() {
  const router = useRouter();
  return (
    <NavigationMenu
      groups={[
        trainingSections.map(({ id, title, subtitle }) => ({
          title,
          subtitle,
          onPress: () => router.push({ pathname: "/training/[section]", params: { section: id } }),
        })),
      ]}
    />
  );
}
