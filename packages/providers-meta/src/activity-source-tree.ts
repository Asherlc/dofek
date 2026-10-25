import { z } from "zod";

export interface ActivitySourceTreeNode {
  id: string;
  providerId: string;
  sourceName: string | null;
  label: string;
  description: string | null;
  url: string | null;
  children: ActivitySourceTreeNode[];
}

export const activitySourceTreeNodeSchema: z.ZodType<ActivitySourceTreeNode> = z.object({
  id: z.string(),
  providerId: z.string(),
  sourceName: z.string().nullable(),
  label: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  children: z.lazy(() => z.array(activitySourceTreeNodeSchema)),
});

export const activitySourceTreeSchema = z.object({
  primary: activitySourceTreeNodeSchema.nullable(),
  otherSources: z.array(activitySourceTreeNodeSchema),
});

export type ActivitySourceTree = z.infer<typeof activitySourceTreeSchema>;
