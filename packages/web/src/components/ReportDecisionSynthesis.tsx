import {
  keyedDecisionSynthesisItems,
  reportDecisionSynthesisSections,
} from "@dofek/format/report-decision-synthesis";
import type { ReportDecisionSynthesis as ReportDecisionSynthesisData } from "dofek-server/types";

export function ReportDecisionSynthesis({ synthesis }: { synthesis: ReportDecisionSynthesisData }) {
  return (
    <section className="card p-6" aria-label="Decision summary">
      <h2 className="text-base font-semibold text-foreground mb-4">Decision summary</h2>
      <div className="space-y-4">
        {reportDecisionSynthesisSections.map((section) => (
          <div key={section.key}>
            <h3 className="text-sm font-medium text-foreground mb-1">{section.title}</h3>
            <ul className="space-y-1 text-sm text-muted">
              {keyedDecisionSynthesisItems(synthesis[section.key]).map((item) => (
                <li key={item.key}>{item.text}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
