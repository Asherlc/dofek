import { compareCodeUnits } from "./code-unit-comparator.ts";

export interface ActivityGroupMember {
  readonly id: string;
  readonly createdAt: Date;
  readonly groupId: string | null;
}

export interface ExistingActivityGroup {
  readonly id: string;
  readonly anchorActivityId: string;
  readonly createdAt: Date;
}

export interface ActivityOverlap {
  readonly activityId: string;
  readonly overlappingActivityId: string;
}

export interface ActivityGroupingInput {
  readonly members: readonly ActivityGroupMember[];
  readonly groups: readonly ExistingActivityGroup[];
  readonly overlaps: readonly ActivityOverlap[];
}

export type ActivityGroupTarget =
  | { readonly kind: "existing"; readonly groupId: string }
  | { readonly kind: "new"; readonly anchorActivityId: string };

export interface ActivityGroupComponentDecision {
  readonly memberIds: readonly [string, ...string[]];
  readonly target: ActivityGroupTarget;
}

export interface ActivityGroupMembershipDecision {
  readonly activityId: string;
  readonly target: ActivityGroupTarget;
}

export interface ActivityGroupAliasDecision {
  readonly aliasGroupId: string;
  readonly groupId: string;
  readonly reason: "merged";
}

export interface ActivityGroupingDecision {
  readonly components: readonly ActivityGroupComponentDecision[];
  readonly memberships: readonly ActivityGroupMembershipDecision[];
  readonly aliases: readonly ActivityGroupAliasDecision[];
}

function compareMembers(left: ActivityGroupMember, right: ActivityGroupMember): number {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() || compareCodeUnits(left.id, right.id)
  );
}

function compareGroups(left: ExistingActivityGroup, right: ExistingActivityGroup): number {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() || compareCodeUnits(left.id, right.id)
  );
}

function connectedComponents(
  members: readonly ActivityGroupMember[],
  overlaps: readonly ActivityOverlap[],
): [ActivityGroupMember, ...ActivityGroupMember[]][] {
  interface MemberNode {
    readonly member: ActivityGroupMember;
    readonly neighbors: Set<MemberNode>;
  }

  const nodes = members.map<MemberNode>((member) => ({ member, neighbors: new Set() }));
  const nodesById = new Map(nodes.map((node) => [node.member.id, node]));

  for (const overlap of overlaps) {
    const left = nodesById.get(overlap.activityId);
    const right = nodesById.get(overlap.overlappingActivityId);
    if (left === undefined || right === undefined) continue;
    left.neighbors.add(right);
    right.neighbors.add(left);
  }

  const visited = new Set<string>();
  const components: [ActivityGroupMember, ...ActivityGroupMember[]][] = [];

  for (const node of nodes) {
    if (visited.has(node.member.id)) continue;

    const component: [ActivityGroupMember, ...ActivityGroupMember[]] = [node.member];
    visited.add(node.member.id);
    const pending = [node];

    for (const current of pending) {
      for (const neighbor of current.neighbors) {
        if (visited.has(neighbor.member.id)) continue;
        visited.add(neighbor.member.id);
        component.push(neighbor.member);
        pending.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

export function reconcileActivityGroups(input: ActivityGroupingInput): ActivityGroupingDecision {
  const components = connectedComponents(input.members, input.overlaps);
  const componentIndexByMemberId = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const member of component) componentIndexByMemberId.set(member.id, componentIndex);
  });

  const retainingGroupsByComponent = new Map<number, ExistingActivityGroup[]>();
  for (const group of input.groups) {
    const componentIndex = componentIndexByMemberId.get(group.anchorActivityId);
    if (componentIndex === undefined) {
      throw new Error(`Activity group ${group.id} has no anchor member ${group.anchorActivityId}`);
    }
    const retainingGroups = retainingGroupsByComponent.get(componentIndex) ?? [];
    retainingGroups.push(group);
    retainingGroupsByComponent.set(componentIndex, retainingGroups);
  }

  const aliases: ActivityGroupAliasDecision[] = [];
  const componentDecisions = components.map<ActivityGroupComponentDecision>(
    (component, componentIndex) => {
      const retainingGroups = (retainingGroupsByComponent.get(componentIndex) ?? []).sort(
        compareGroups,
      );
      const winner = retainingGroups[0];
      component.sort(compareMembers);
      const newGroupAnchorActivityId = component[0].id;
      component.sort((left, right) => compareCodeUnits(left.id, right.id));

      if (winner === undefined) {
        return {
          memberIds: [component[0].id, ...component.slice(1).map((member) => member.id)],
          target: { kind: "new", anchorActivityId: newGroupAnchorActivityId },
        };
      }

      for (const loser of retainingGroups.slice(1)) {
        aliases.push({ aliasGroupId: loser.id, groupId: winner.id, reason: "merged" });
      }

      return {
        memberIds: [component[0].id, ...component.slice(1).map((member) => member.id)],
        target: { kind: "existing", groupId: winner.id },
      };
    },
  );

  return {
    aliases: aliases.sort((left, right) => compareCodeUnits(left.aliasGroupId, right.aliasGroupId)),
    components: componentDecisions.sort((left, right) =>
      compareCodeUnits(left.memberIds[0], right.memberIds[0]),
    ),
    memberships: componentDecisions.flatMap((component) =>
      component.memberIds.map((activityId) => ({ activityId, target: component.target })),
    ),
  };
}
