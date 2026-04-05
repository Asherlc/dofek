export const DASHBOARD_GRID_PAIRS: Readonly<Record<string, string>> = {
  strain: "nextWorkout",
  weeklyReport: "sleepNeed",
  stress: "healthspan",
  spo2Temp: "steps",
};

export const DASHBOARD_GRID_PAIR_SECONDARIES: Readonly<Record<string, string>> = {
  nextWorkout: "strain",
  sleepNeed: "weeklyReport",
  healthspan: "stress",
  steps: "spo2Temp",
};

export function getDashboardGridGroupIds(sectionId: string): string[] {
  const pairedSectionId = DASHBOARD_GRID_PAIRS[sectionId];
  if (pairedSectionId) {
    return [sectionId, pairedSectionId];
  }

  const primarySectionId = DASHBOARD_GRID_PAIR_SECONDARIES[sectionId];
  if (primarySectionId) {
    return [primarySectionId, sectionId];
  }

  return [sectionId];
}

export function reorderDashboardSections(
  order: string[],
  sectionId: string,
  direction: "up" | "down",
): string[] {
  const sectionIndex = order.indexOf(sectionId);
  if (sectionIndex === -1) {
    return order;
  }

  const sectionsToMove = getDashboardGridGroupIds(sectionId).filter((id) => order.includes(id));
  const sectionsToMoveSet = new Set(sectionsToMove);

  // Find the boundary index of the group in the current order
  const groupIndices = sectionsToMove.map((id) => order.indexOf(id));
  const firstGroupIndex = Math.min(...groupIndices);
  const lastGroupIndex = Math.max(...groupIndices);

  if (direction === "up") {
    if (firstGroupIndex <= 0) {
      return order;
    }

    const targetSectionId = order[firstGroupIndex - 1];
    if (targetSectionId === undefined) {
      return order;
    }

    const targetGroupIds = getDashboardGridGroupIds(targetSectionId).filter(
      (id) => !sectionsToMoveSet.has(id) && order.includes(id),
    );
    const filteredOrder = order.filter((id) => !sectionsToMoveSet.has(id));
    const insertBeforeId = targetGroupIds[0] ?? targetSectionId;
    const insertAt = filteredOrder.indexOf(insertBeforeId);
    filteredOrder.splice(insertAt, 0, ...sectionsToMove);
    return filteredOrder;
  }

  // direction === "down"
  if (lastGroupIndex >= order.length - 1) {
    return order;
  }

  const targetSectionId = order[lastGroupIndex + 1];
  if (targetSectionId === undefined) {
    return order;
  }

  const targetGroupIds = getDashboardGridGroupIds(targetSectionId).filter(
    (id) => !sectionsToMoveSet.has(id) && order.includes(id),
  );
  const filteredOrder = order.filter((id) => !sectionsToMoveSet.has(id));
  const insertAfterId = targetGroupIds[targetGroupIds.length - 1] ?? targetSectionId;
  const insertAt = filteredOrder.indexOf(insertAfterId);
  filteredOrder.splice(insertAt + 1, 0, ...sectionsToMove);
  return filteredOrder;
}
