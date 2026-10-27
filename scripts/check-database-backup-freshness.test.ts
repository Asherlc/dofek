import { describe, expect, it, vi } from "vitest";
import {
  checkDatabaseBackupFreshness,
  type ListDatabaseBackupObjectsPage,
} from "./check-database-backup-freshness.ts";

const now = new Date("2026-07-26T12:00:00.000Z");

function page(
  objects: Array<{ key?: string; lastModified?: Date }>,
  pagination: {
    isTruncated?: boolean;
    nextContinuationToken?: string;
  } = {},
): ListDatabaseBackupObjectsPage {
  return {
    objects,
    ...pagination,
  };
}

describe("checkDatabaseBackupFreshness", () => {
  it("fails when the backup bucket is empty", async () => {
    const listObjectsPage = vi.fn().mockResolvedValue(page([]));

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).rejects.toThrow(
      "No database backups found in R2 bucket dofek-db-backups",
    );
  });

  it("fails when a backup object is missing its last-modified timestamp", async () => {
    const listObjectsPage = vi.fn().mockResolvedValue(
      page([
        {
          key: "health-2026-07-26.backup",
        },
      ]),
    );

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).rejects.toThrow(
      "Database backup object health-2026-07-26.backup is missing LastModified",
    );
  });

  it("fails when a backup object is missing its key", async () => {
    const listObjectsPage = vi.fn().mockResolvedValue(
      page([
        {
          lastModified: new Date("2026-07-26T11:00:00.000Z"),
        },
      ]),
    );

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).rejects.toThrow(
      "Database backup object is missing its key",
    );
  });

  it("accepts a backup newer than 24 hours", async () => {
    const listObjectsPage = vi.fn().mockResolvedValue(
      page([
        {
          key: "health-2026-07-25.backup",
          lastModified: new Date("2026-07-25T12:00:00.001Z"),
        },
      ]),
    );

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).resolves.toEqual({
      ageMilliseconds: 86_399_999,
      key: "health-2026-07-25.backup",
      lastModified: new Date("2026-07-25T12:00:00.001Z"),
    });
  });

  it("fails at the 24-hour freshness boundary", async () => {
    const listObjectsPage = vi.fn().mockResolvedValue(
      page([
        {
          key: "health-2026-07-25.backup",
          lastModified: new Date("2026-07-25T12:00:00.000Z"),
        },
      ]),
    );

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).rejects.toThrow(
      "Newest database backup health-2026-07-25.backup is stale: 24.00 hours old; required age is under 24 hours",
    );
  });

  it("selects the newest backup regardless of object listing order", async () => {
    const listObjectsPage = vi.fn().mockResolvedValue(
      page([
        {
          key: "health-newest.backup",
          lastModified: new Date("2026-07-26T11:00:00.000Z"),
        },
        {
          key: "health-oldest.backup",
          lastModified: new Date("2026-07-20T12:00:00.000Z"),
        },
        {
          key: "health-middle.backup",
          lastModified: new Date("2026-07-25T12:00:00.001Z"),
        },
      ]),
    );

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).resolves.toMatchObject({
      ageMilliseconds: 3_600_000,
      key: "health-newest.backup",
      lastModified: new Date("2026-07-26T11:00:00.000Z"),
    });
  });

  it("follows continuation tokens and selects the newest object across pages", async () => {
    const listObjectsPage = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            {
              key: "health-first-page.backup",
              lastModified: new Date("2026-07-25T13:00:00.000Z"),
            },
          ],
          {
            isTruncated: true,
            nextContinuationToken: "next-page",
          },
        ),
      )
      .mockResolvedValueOnce(
        page([
          {
            key: "health-second-page.backup",
            lastModified: new Date("2026-07-26T11:30:00.000Z"),
          },
        ]),
      );

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).resolves.toMatchObject({
      key: "health-second-page.backup",
    });
    expect(listObjectsPage).toHaveBeenNthCalledWith(1, {
      bucket: "dofek-db-backups",
      continuationToken: undefined,
    });
    expect(listObjectsPage).toHaveBeenNthCalledWith(2, {
      bucket: "dofek-db-backups",
      continuationToken: "next-page",
    });
  });

  it("fails when a truncated page omits its continuation token", async () => {
    const listObjectsPage = vi.fn().mockResolvedValue(
      page(
        [
          {
            key: "health.backup",
            lastModified: new Date("2026-07-26T11:00:00.000Z"),
          },
        ],
        { isTruncated: true },
      ),
    );

    await expect(checkDatabaseBackupFreshness({ listObjectsPage, now })).rejects.toThrow(
      "R2 returned a truncated backup listing without a continuation token",
    );
  });
});
