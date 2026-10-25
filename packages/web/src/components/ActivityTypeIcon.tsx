import { getActivityIconInfo } from "@dofek/training/activity-icons";
import { formatActivityTypeLabel } from "@dofek/training/training";

interface ActivityTypeIconProps {
  activityType: string;
  variant?: "card" | "compact" | "plain";
  className?: string;
  color?: string;
}

export function ActivityTypeIcon({
  activityType,
  variant = "card",
  className = "",
  color,
}: ActivityTypeIconProps) {
  const { svg, gradientFrom, gradientTo } = getActivityIconInfo(activityType);
  const label = formatActivityTypeLabel(activityType);
  const isCompact = variant === "compact";
  const isPlain = variant === "plain";
  const maskImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

  return (
    <div
      data-testid="activity-type-icon"
      data-activity-type={activityType}
      className={[
        "relative overflow-hidden",
        isPlain ? "text-foreground" : "text-white",
        isCompact ? "h-12 w-16 rounded" : isPlain ? "h-12 w-16" : "aspect-[16/9] w-full",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={`${label} activity`}
      style={{
        color,
        backgroundImage: isPlain
          ? undefined
          : `linear-gradient(to bottom right, ${gradientFrom}, ${gradientTo})`,
      }}
    >
      <div className="flex h-full w-full items-center justify-center">
        <span
          data-activity-glyph=""
          className={isCompact ? "h-9 w-9" : isPlain ? "h-10 w-10" : "h-18 w-18"}
          aria-hidden="true"
          style={{
            backgroundColor: "currentColor",
            maskImage,
            maskRepeat: "no-repeat",
            maskPosition: "center",
            maskSize: "contain",
            WebkitMaskImage: maskImage,
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            WebkitMaskSize: "contain",
          }}
        />
      </div>
    </div>
  );
}
