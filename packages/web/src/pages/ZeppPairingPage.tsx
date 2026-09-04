import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { ZeppPairingPanel } from "../components/ZeppPairingPanel.tsx";

export function ZeppPairingPage({ initialCode }: { initialCode?: string }) {
  return (
    <PageLayout title="Pair Zepp App" subtitle="Connect a Zepp watch app to your Dofek account">
      <PageSection title="Zepp App Pairing" subtitle="Enter the code shown by Zepp">
        <ZeppPairingPanel initialCode={initialCode} />
      </PageSection>
    </PageLayout>
  );
}
