export interface EvidenceDetail {
  key: string;
  label?: string;
  value?: string | null;
}

interface EvidenceDetailsProps {
  details: readonly EvidenceDetail[];
  className?: string;
  textClassName?: string;
}

export function EvidenceDetails({
  details,
  className,
  textClassName = "text-muted",
}: EvidenceDetailsProps) {
  const presentDetails = details.filter(
    (detail): detail is EvidenceDetail & { value: string } =>
      typeof detail.value === "string" && detail.value.trim().length > 0,
  );

  if (presentDetails.length === 0) return null;

  const rootClassName = ["space-y-1 text-xs", textClassName, className]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return (
    <div className={rootClassName}>
      {presentDetails.map(({ key, label, value }) => (
        <p key={key}>
          {label ? <span className="font-medium">{label}: </span> : null}
          {value}
        </p>
      ))}
    </div>
  );
}
