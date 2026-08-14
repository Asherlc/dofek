export function ActivityPerceivedExertion({ value }: { value: number | null }) {
  return (
    <section className="card p-4 space-y-3" aria-labelledby="activity-rpe-heading">
      <div>
        <h2 id="activity-rpe-heading" className="font-medium">
          Session effort
        </h2>
        <p className="text-xs text-muted">Stored perceived exertion for this session (0–10).</p>
      </div>
      <span className="text-lg font-medium">{value ?? "—"}</span>
    </section>
  );
}
