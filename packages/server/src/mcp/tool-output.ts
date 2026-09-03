import { z } from "zod";

/** Object-root envelope for MCP tools whose JSON result may be an array or nullable value. */
export const jsonToolOutputSchema = z.object({ result: z.json() });
