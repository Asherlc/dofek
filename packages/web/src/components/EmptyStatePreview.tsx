export interface EmptyStatePreviewContent {
  title: string;
  message: string;
  requirement?: string;
  previewTitle: string;
  previewItems: readonly string[];
  note: string;
}

export function EmptyStatePreview({ content }: { content: EmptyStatePreviewContent }) {
  return (
    <section className="card p-6">
      <h3 className="text-base font-semibold text-foreground">{content.title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted">{content.message}</p>
      {content.requirement ? (
        <p className="mt-3 text-sm font-medium leading-6 text-foreground">{content.requirement}</p>
      ) : null}
      <h4 className="mt-5 text-sm font-semibold text-foreground">{content.previewTitle}</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-muted">
        {content.previewItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-5 text-subtle">{content.note}</p>
    </section>
  );
}
