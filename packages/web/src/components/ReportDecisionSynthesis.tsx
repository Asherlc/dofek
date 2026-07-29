import type { ReportDecisionSynthesis as ReportDecisionSynthesisData } from "dofek-server/types";

const sections: {
  key: keyof ReportDecisionSynthesisData;
  title: string;
}[] = [
  { key: "whatChanged", title: "What changed" },
  { key: "likelyAssociations", title: "Likely associations" },
  { key: "whatWorked", title: "What worked" },
  { key: "whatToTryNext", title: "What to try next" },
  { key: "confidenceAndMissingData", title: "Confidence and missing data" },
];

export function ReportDecisionSynthesis({ synthesis }: { synthesis: ReportDecisionSynthesisData }) {
  return (
    <section className="card p-6" aria-label="Decision summary">
      <h2 className="text-base font-semibold text-foreground mb-4">Decision summary</h2>
      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.key}>
            <h3 className="text-sm font-medium text-foreground mb-1">{section.title}</h3>
            <ul className="space-y-1 text-sm text-muted">
              {synthesis[section.key].map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
