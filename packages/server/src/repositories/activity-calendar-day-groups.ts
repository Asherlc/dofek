import type { CalendarActivityEntry, CalendarDayActivities } from "./activity-calendar-entry.ts";

export function mergeDayGroups(
  activeDays: CalendarDayActivities[],
  hiddenDays: CalendarDayActivities[],
): CalendarDayActivities[] {
  const byDate = new Map<string, Map<string, CalendarActivityEntry>>();
  for (const group of [...activeDays, ...hiddenDays]) {
    let activitiesById = byDate.get(group.date);
    if (!activitiesById) {
      activitiesById = new Map();
      byDate.set(group.date, activitiesById);
    }
    for (const activity of group.activities) {
      if (!activitiesById.has(activity.id)) {
        activitiesById.set(activity.id, activity);
      }
    }
  }

  return Array.from(byDate.entries())
    .map(([date, activitiesById]) => ({
      date,
      activities: Array.from(activitiesById.values()).sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      ),
    }))
    .sort((left, right) => right.date.localeCompare(left.date));
}
