import { getActivityIconInfo } from "@dofek/training/activity-icons";
import { formatActivityTypeLabel } from "@dofek/training/training";

interface ActivityTypeIconProps {
  activityType: string;
  variant?: "card" | "compact";
  className?: string;
}

export function ActivityTypeIcon({
  activityType,
  variant = "card",
  className = "",
}: ActivityTypeIconProps) {
  const { emoji, gradientFrom, gradientTo } = getActivityIconInfo(activityType);
  const label = formatActivityTypeLabel(activityType);
  const isCompact = variant === "compact";

  return (
    <div
      data-testid="activity-type-icon"
      data-activity-type={activityType}
      className={[
        "relative overflow-hidden",
        isCompact ? "h-12 w-16 rounded" : "aspect-[16/9] w-full",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={`${label} activity`}
      style={{
        backgroundImage: `linear-gradient(to bottom right, ${gradientFrom}, ${gradientTo})`,
      }}
    >
      <div className="flex h-full w-full items-center justify-center">
        <span
          className={isCompact ? "text-2xl leading-none" : "text-5xl leading-none"}
          aria-hidden="true"
        >
          {emoji}
        </span>
      </div>
    </div>
  );
}
