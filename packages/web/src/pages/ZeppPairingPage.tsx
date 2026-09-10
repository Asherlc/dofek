import { PageLayout } from "../components/PageLayout.tsx";
import { ZeppPairingPanel } from "../components/ZeppPairingPanel.tsx";

export function ZeppPairingPage({ initialCode }: { initialCode?: string }) {
  return (
    <PageLayout title="Pair your Zepp app" subtitle="Enter the code shown in Zepp">
      <div className="card p-6">
        <ZeppPairingPanel initialCode={initialCode} />
      </div>
    </PageLayout>
  );
}
