export function DateRangeFilterField({
  column,
  inputType,
  fromValue,
  toValue,
  onFromChange,
  onToChange,
  className,
}: {
  column: { key: string; label: string };
  inputType: "date" | "datetime-local";
  fromValue: string;
  toValue: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  className: string;
}) {
  return (
    <div className="flex min-w-[8rem] flex-col gap-1">
      <input
        type={inputType}
        value={fromValue}
        onChange={(event) => onFromChange(event.target.value)}
        aria-label={`Filter ${column.label} from`}
        placeholder="From"
        className={className}
      />
      <input
        type={inputType}
        value={toValue}
        onChange={(event) => onToChange(event.target.value)}
        aria-label={`Filter ${column.label} to`}
        placeholder="To"
        className={className}
      />
    </div>
  );
}
