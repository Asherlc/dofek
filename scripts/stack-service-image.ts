import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { immutableImageReference } from "./deploy-image-reference.ts";

const [file, service] = z
  .tuple([z.string().min(1), z.string().min(1)])
  .parse(process.argv.slice(2));
const stack = z
  .object({ services: z.record(z.string(), z.unknown()) })
  .parse(parse(readFileSync(file, "utf8"), { merge: true }));
const configured = z.object({ image: z.string().min(1) }).safeParse(stack.services[service]);
if (!configured.success) {
  throw new Error(`${file}: services.${service}.image must be configured`, {
    cause: configured.error,
  });
}
console.log(immutableImageReference(configured.data.image));
