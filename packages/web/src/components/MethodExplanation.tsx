interface MethodExplanationProps {
  className: string;
  lines: readonly string[];
  source: {
    title: string;
    url: string;
  };
}

export function MethodExplanation({ className, lines, source }: MethodExplanationProps) {
  return (
    <div className={`${className} space-y-1 text-xs text-dim`}>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <a className="text-link hover:underline" href={source.url} rel="noreferrer" target="_blank">
        {source.title}
      </a>
    </div>
  );
}
