import { Sha256 } from "@aws-crypto/sha256-browser";
import { randomUUID } from "expo-crypto";
import { File, FileMode, Paths } from "expo-file-system";
import type { UploadableMobileFile } from "./resumable-file-upload";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createExpoUploadableMobileFile(
  fileUri: string,
): UploadableMobileFile & { text(): Promise<string> } {
  const file = new File(fileUri);
  if (!file.exists) throw new Error(`Shared file does not exist: ${fileUri}`);

  return {
    uri: file.uri,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    text: () => file.text(),
    async sha256() {
      const digest = new Sha256();
      const handle = file.open(FileMode.ReadOnly);
      try {
        let remaining = file.size;
        while (remaining > 0) {
          const bytes = handle.readBytes(Math.min(4 * 1024 * 1024, remaining));
          digest.update(bytes);
          remaining -= bytes.byteLength;
        }
      } finally {
        handle.close();
      }
      return bytesToHex(await digest.digest());
    },
    async uploadPart({ url, offset, length, onProgress }) {
      let uploadFile = file;
      let temporaryPart: File | null = null;
      if (offset !== 0 || length !== file.size) {
        const handle = file.open(FileMode.ReadOnly);
        try {
          handle.offset = offset;
          const bytes = handle.readBytes(length);
          temporaryPart = new File(Paths.cache, `dofek-upload-part-${randomUUID()}`);
          temporaryPart.create();
          temporaryPart.write(bytes);
          uploadFile = temporaryPart;
        } finally {
          handle.close();
        }
      }

      try {
        const result = await uploadFile
          .createUploadTask(url, { httpMethod: "PUT", onProgress, sessionType: "foreground" })
          .uploadAsync();
        return result;
      } finally {
        if (temporaryPart?.exists) temporaryPart.delete();
      }
    },
  };
}
