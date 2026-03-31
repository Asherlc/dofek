import {
  computeIntensities,
  computeSlugTotals,
  INTENSITY_COLORS,
  intensityToBucket,
  muscleGroupFillColor,
} from "@dofek/training/muscle-groups";
import type { MuscleGroupVolumeRow } from "dofek-server/types";
import Model, { type IExerciseData, type Muscle, MuscleType } from "react-body-highlighter";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface MuscleGroupVolumeChartProps {
  data: MuscleGroupVolumeRow[];
  loading?: boolean;
}

/**
 * Map from shared module slugs to react-body-highlighter muscles.
 * Most slugs match directly; deltoids need splitting for front/back.
 */
const DELTOID_MUSCLES = [MuscleType.FRONT_DELTOIDS, MuscleType.BACK_DELTOIDS];

/** All valid muscle slugs from the library, for type-safe lookup. */
const VALID_MUSCLES = new Set<string>(Object.values(MuscleType));

function isMuscle(value: string): value is Muscle {
  return VALID_MUSCLES.has(value);
}

function toExerciseData(slug: string, frequency: number): IExerciseData[] {
  if (slug === "deltoids") {
    return DELTOID_MUSCLES.map((muscle) => ({
      name: slug,
      muscles: [muscle],
      frequency,
    }));
  }
  if (!isMuscle(slug)) return [];
  return [{ name: slug, muscles: [slug], frequency }];
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

  const slugTotals = computeSlugTotals(data);
  const intensities = computeIntensities(slugTotals);

  // Build the react-body-highlighter data format
  const exerciseData: IExerciseData[] = [...intensities.entries()].flatMap(([slug, intensity]) => {
    const bucket = intensityToBucket(intensity);
    if (bucket === 0) return [];
    return toExerciseData(slug, bucket);
  });

  return (
    <div>
      <div className="flex justify-center gap-4">
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Front</span>
          <Model
            data={exerciseData}
            style={{ width: "140px" }}
            type="anterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Back</span>
          <Model
            data={exerciseData}
            style={{ width: "140px" }}
            type="posterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
      </div>
      <ColorLegend />
    </div>
  );
}

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
