import {
  BACK_PATHS,
  BODY_VIEWBOX,
  computeIntensities,
  computeRegionTotals,
  FRONT_PATHS,
  muscleGroupFillColor,
  muscleGroupLabel,
  STRUCTURAL_COLOR,
  UNTRAINED_COLOR,
} from "@dofek/training/muscle-groups";
import type { MuscleGroupVolumeRow } from "dofek-server/types";
import { useRef, useState } from "react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface MuscleGroupVolumeChartProps {
  data: MuscleGroupVolumeRow[];
  loading?: boolean;
}

export function MuscleGroupVolumeChart({ data, loading }: MuscleGroupVolumeChartProps) {
  if (loading) return <ChartLoadingSkeleton height={320} />;
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height: 320 }}>
        <span className="text-dim text-sm">No muscle group data</span>
      </div>
    );
  }

  const regionTotals = computeRegionTotals(data);
  const intensities = computeIntensities(regionTotals);

  return (
    <div>
      <div className="flex justify-center gap-6">
        <BodyView
          label="Front"
          paths={FRONT_PATHS}
          intensities={intensities}
          regionTotals={regionTotals}
        />
        <BodyView
          label="Back"
          paths={BACK_PATHS}
          intensities={intensities}
          regionTotals={regionTotals}
        />
      </div>
      <ColorLegend />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flatten paths into a single array with stable keys for rendering
// ---------------------------------------------------------------------------

interface FlatPath {
  key: string;
  group: string;
  pathData: string;
  isStructural: boolean;
}

function flattenPaths(paths: Record<string, string[]>): FlatPath[] {
  const result: FlatPath[] = [];
  for (const [group, groupPaths] of Object.entries(paths)) {
    const isStructural = group.startsWith("_");
    for (const [index, pathData] of groupPaths.entries()) {
      const side = groupPaths.length > 1 ? (index === 0 ? "left" : "right") : "center";
      result.push({
        key: `${group}-${side}`,
        group,
        pathData,
        isStructural,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Body SVG view (front or back)
// ---------------------------------------------------------------------------

function BodyView({
  label,
  paths,
  intensities,
  regionTotals,
}: {
  label: string;
  paths: Record<string, string[]>;
  intensities: Map<string, number>;
  regionTotals: Map<string, number>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{
    group: string;
    sets: number;
    x: number;
    y: number;
  } | null>(null);

  const flatPaths = flattenPaths(paths);

  function handleSvgMouseMove(event: React.MouseEvent<SVGSVGElement>) {
    const target = event.target;
    if (!(target instanceof SVGPathElement)) {
      setTooltip(null);
      return;
    }
    const group = target.dataset.group;
    if (!group) {
      setTooltip(null);
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      group,
      sets: Math.round(regionTotals.get(group) ?? 0),
      x: event.clientX - rect.left,
      y: event.clientY - rect.top - 30,
    });
  }

  return (
    <div className="flex flex-col items-center">
      <span className="text-xs text-dim mb-1">{label}</span>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${BODY_VIEWBOX.width} ${BODY_VIEWBOX.height}`}
          width={140}
          height={140 * (BODY_VIEWBOX.height / BODY_VIEWBOX.width)}
          role="img"
          aria-label={`${label} view of muscle group training volume`}
          onMouseMove={handleSvgMouseMove}
          onMouseLeave={() => setTooltip(null)}
        >
          <title>{label} muscle group volume</title>
          {flatPaths.map((flatPath) => {
            const intensity = flatPath.isStructural ? 0 : (intensities.get(flatPath.group) ?? 0);
            const fill = flatPath.isStructural
              ? STRUCTURAL_COLOR
              : intensity > 0
                ? muscleGroupFillColor(intensity)
                : UNTRAINED_COLOR;

            return (
              <path
                key={flatPath.key}
                d={flatPath.pathData}
                fill={fill}
                stroke="#c0c8bf"
                strokeWidth={0.5}
                data-group={flatPath.isStructural ? undefined : flatPath.group}
                style={{
                  cursor: flatPath.isStructural ? "default" : "pointer",
                  transition: "fill 0.2s",
                }}
              />
            );
          })}
        </svg>
        {tooltip && (
          <div
            className="absolute pointer-events-none bg-white border border-muted rounded px-2 py-1 shadow-sm text-xs whitespace-nowrap z-10"
            style={{ left: tooltip.x, top: tooltip.y, transform: "translateX(-50%)" }}
          >
            <span className="font-medium">{muscleGroupLabel(tooltip.group)}</span>
            {": "}
            <span>{tooltip.sets} sets</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function ColorLegend() {
  return (
    <div className="flex items-center justify-center gap-2 mt-3">
      <span className="text-[10px] text-dim">Less</span>
      <div
        className="h-2 rounded-full"
        style={{
          width: 80,
          background: `linear-gradient(to right, ${muscleGroupFillColor(0.01)}, ${muscleGroupFillColor(1)})`,
        }}
      />
      <span className="text-[10px] text-dim">More</span>
    </div>
  );
}
