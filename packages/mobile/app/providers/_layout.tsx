import { Stack } from "expo-router";
import { rootStackScreenOptions } from "../_layout";

export default function ProvidersLayout() {
  return (
    <Stack screenOptions={rootStackScreenOptions}>
      <Stack.Screen name="index" options={{ title: "Data Sources" }} />
      <Stack.Screen name="[id]" options={{ title: "Provider Detail" }} />
    </Stack>
  );
}
