export function ActivityPerceivedExertion({ value }: { value: number | null }) {
  if (value == null) return null;

  return (
    <section className="card p-4 space-y-3" aria-labelledby="activity-rpe-heading">
      <div>
        <h2 id="activity-rpe-heading" className="font-medium">
          Session effort
        </h2>
      </div>
      <span className="text-lg font-medium">{value}/10</span>
    </section>
  );
}
