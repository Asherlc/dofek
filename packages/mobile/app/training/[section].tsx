import { Stack, useLocalSearchParams } from "expo-router";
import { QueryStatePanel } from "../../components/QueryStatePanel";
import { trainingSections } from "../../lib/training-sections";
import { TrainingAnalysis } from "../strain";

export default function TrainingSectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>();
  const destination = trainingSections.find(({ id }) => id === section);
  if (!destination) {
    return <QueryStatePanel variant="empty" title="Training section unavailable" />;
  }
  return (
    <>
      <Stack.Screen options={{ title: destination.title }} />
      <TrainingAnalysis section={destination.id} />
    </>
  );
}
