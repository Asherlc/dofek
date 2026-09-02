interface MethodExplanationProps {
  className: string;
  lines: readonly string[];
  technicalName?: string;
  source?: {
    title: string;
    url: string;
  };
}

export function MethodExplanation({
  className,
  lines,
  technicalName,
  source,
}: MethodExplanationProps) {
  return (
    <details className={`${className} text-xs text-dim`}>
      <summary className="cursor-pointer font-medium text-muted underline-offset-2 hover:underline">
        How this is calculated
      </summary>
      <div className="mt-2 space-y-1">
        {technicalName ? <p>Technical name: {technicalName}</p> : null}
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {source ? (
          <a
            className="text-link hover:underline"
            href={source.url}
            rel="noreferrer"
            target="_blank"
          >
            {source.title}
          </a>
        ) : null}
      </div>
    </details>
  );
}
