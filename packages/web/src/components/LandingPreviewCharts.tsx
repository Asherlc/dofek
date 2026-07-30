export function LandingPreviewScatterPlot({
  accessibleName,
  descending = false,
  xAxisLabel,
  xTickLabels,
  yAxisLabel,
  yTickLabels,
}: {
  accessibleName: string;
  descending?: boolean;
  xAxisLabel: string;
  xTickLabels: readonly [string, string];
  yAxisLabel: string;
  yTickLabels: readonly [string, string];
}) {
  const points: readonly (readonly [number, number])[] = descending
    ? [
        [8, 18],
        [18, 26],
        [28, 30],
        [38, 35],
        [50, 42],
        [62, 46],
        [74, 54],
        [88, 60],
        [20, 44],
        [42, 50],
        [66, 34],
        [80, 40],
      ]
    : [
        [8, 58],
        [16, 50],
        [24, 47],
        [34, 42],
        [42, 38],
        [54, 30],
        [66, 28],
        [76, 22],
        [88, 18],
        [26, 30],
        [48, 24],
        [70, 40],
      ];

  return (
    <div className="min-w-0">
      <div className="text-[9px] font-medium text-subtle">{yAxisLabel}</div>
      <svg viewBox="0 0 120 72" className="h-20 w-full" role="img" aria-label={accessibleName}>
        <path d="M12 60H116" stroke="var(--color-border-strong)" strokeWidth="1" />
        <path d="M12 8V60" stroke="var(--color-border-strong)" strokeWidth="1" />
        <path
          d={descending ? "M16 16 L112 54" : "M16 56 L112 14"}
          stroke="var(--color-accent-secondary)"
          strokeWidth="1.5"
        />
        {points.map(([xPosition, yPosition]) => (
          <circle
            key={`${xPosition}-${yPosition}`}
            cx={xPosition + 8}
            cy={yPosition - 4}
            r="2"
            fill="var(--color-accent-secondary)"
            opacity="0.75"
          />
        ))}
        <text x="1" y="12" fill="var(--color-subtle)" fontSize="7">
          {yTickLabels[1]}
        </text>
        <text x="1" y="61" fill="var(--color-subtle)" fontSize="7">
          {yTickLabels[0]}
        </text>
        <text x="12" y="70" fill="var(--color-subtle)" fontSize="7">
          {xTickLabels[0]}
        </text>
        <text x="116" y="70" textAnchor="end" fill="var(--color-subtle)" fontSize="7">
          {xTickLabels[1]}
        </text>
      </svg>
      <div className="text-center text-[9px] font-medium text-subtle">{xAxisLabel}</div>
    </div>
  );
}

export function LandingPreviewLineChart({
  accessibleName,
  color,
  endLabel,
  startLabel,
  yAxisLabel,
  yTickLabels,
}: {
  accessibleName: string;
  color: string;
  endLabel: string;
  startLabel: string;
  yAxisLabel: string;
  yTickLabels: readonly [string, string];
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-medium text-subtle">{yAxisLabel}</div>
      <svg viewBox="0 0 160 72" className="h-20 w-full" role="img" aria-label={accessibleName}>
        <path d="M14 8V62H158" stroke="var(--color-border-strong)" strokeWidth="1" fill="none" />
        <path
          d="M14 18 C30 20 40 38 56 34 C74 30 84 48 102 44 C122 40 134 56 158 52"
          fill="none"
          stroke={color}
          strokeWidth="2"
        />
        <path
          d="M14 18 C30 20 40 38 56 34 C74 30 84 48 102 44 C122 40 134 56 158 52 L158 62 L14 62Z"
          fill={color}
          opacity="0.08"
        />
        <text x="1" y="12" fill="var(--color-subtle)" fontSize="7">
          {yTickLabels[1]}
        </text>
        <text x="1" y="62" fill="var(--color-subtle)" fontSize="7">
          {yTickLabels[0]}
        </text>
      </svg>
      <div className="flex justify-between text-[9px] text-subtle">
        <span>{startLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
}
