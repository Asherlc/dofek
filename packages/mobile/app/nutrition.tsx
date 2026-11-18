import { Stack } from "expo-router";
import FoodScreen from "./food";

export default function NutritionScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Nutrition" }} />
      <FoodScreen />
    </>
  );
}
