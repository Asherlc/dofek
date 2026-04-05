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
  if (!order.includes(sectionId)) {
    return order;
  }

  const sectionsToMove = getDashboardGridGroupIds(sectionId).filter((id) => order.includes(id));
  if (sectionsToMove.length === 0) {
    return order;
  }

  const sectionsToMoveSet = new Set(sectionsToMove);
  const sectionIndices = sectionsToMove
    .map((id) => order.indexOf(id))
    .filter((index) => index !== -1)
    .sort((leftIndex, rightIndex) => leftIndex - rightIndex);

  if (sectionIndices.length === 0) {
    return order;
  }

  if (direction === "up") {
    const firstIndex = sectionIndices[0] ?? 0;
    if (firstIndex <= 0) {
      return order;
    }

    const targetSectionId = order[firstIndex - 1];
    if (targetSectionId == null) {
      return order;
    }

    const targetGroupIds = getDashboardGridGroupIds(targetSectionId).filter(
      (id) => !sectionsToMoveSet.has(id) && order.includes(id),
    );
    const filteredOrder = order.filter((id) => !sectionsToMoveSet.has(id));
    const insertBeforeId = targetGroupIds[0] ?? targetSectionId;
    const insertAt = filteredOrder.indexOf(insertBeforeId);
    if (insertAt === -1) {
      return order;
    }

    filteredOrder.splice(insertAt, 0, ...sectionsToMove);
    return filteredOrder;
  }

  const lastIndex = sectionIndices[sectionIndices.length - 1] ?? order.length - 1;
  if (lastIndex >= order.length - 1) {
    return order;
  }

  const targetSectionId = order[lastIndex + 1];
  if (targetSectionId == null) {
    return order;
  }

  const targetGroupIds = getDashboardGridGroupIds(targetSectionId).filter(
    (id) => !sectionsToMoveSet.has(id) && order.includes(id),
  );
  const filteredOrder = order.filter((id) => !sectionsToMoveSet.has(id));
  const insertAfterId = targetGroupIds[targetGroupIds.length - 1] ?? targetSectionId;
  const insertAt = filteredOrder.indexOf(insertAfterId);
  if (insertAt === -1) {
    return order;
  }

  filteredOrder.splice(insertAt + 1, 0, ...sectionsToMove);
  return filteredOrder;
}
