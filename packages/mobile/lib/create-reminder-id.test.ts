import { describe, expect, it, vi } from "vitest";
import { createReminderId } from "./create-reminder-id.ts";

describe("createReminderId", () => {
  it("uses crypto.randomUUID when available", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    });

    expect(createReminderId()).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("falls back to getRandomValues when randomUUID is missing", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const reminderId = createReminderId();
    expect(reminderId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
