import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const mutantKitIdentity = {
  toolVersion: "1.3.2",
  toolCommitSHA: "1e345263e36e1658adeed6ae919b7f5875a2601b",
  swiftSyntaxVersion: "604.0.0",
} as const;

export function getMutantKitExecutable(
  output: (command: string, args: string[]) => string,
): string {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The approved MutantKit artifact requires macOS arm64.");
  }
  const directory = output("mise", ["where", "github:juntaki/mutantkit@1.3.2"]).trim();
  if (!isAbsolute(directory))
    throw new Error(`Invalid mise MutantKit installation path: ${directory}`);
  const executable = join(directory, "mutantkit");
  const checksum = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (checksum !== "b838653c3eb201e012127d945a236dddfd991c6f034eab69aca792d77ba08be3") {
    throw new Error(`MutantKit executable checksum mismatch: ${executable}`);
  }
  const expected = `mutantkit ${mutantKitIdentity.toolVersion}\ncommit: ${mutantKitIdentity.toolCommitSHA}\nswift-syntax: ${mutantKitIdentity.swiftSyntaxVersion}\nplan schema: 1\nreport schema: 2`;
  if (output(executable, ["--version"]).trim() !== expected) {
    throw new Error(
      `MutantKit identity mismatch: expected version, commit, SwiftSyntax and schemas from the approved artifact (${executable})`,
    );
  }
  return executable;
}
