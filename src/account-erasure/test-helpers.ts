import { TarArchive } from "archiver";
import { GenericContainer, Wait } from "testcontainers";

/** Digest-pinned SeaweedFS release used as the S3-compatible stand-in for local/CI. */
export const seaweedFsS3Image =
  "chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882";

/**
 * Single-node SeaweedFS with the S3 API on port 9000 (path-style).
 * Signed streaming uploads require explicit identities even when ordinary
 * anonymous S3 requests work without an IAM config.
 */
export function createSeaweedFsS3Container(credentials?: {
  accessKeyId: string;
  secretAccessKey: string;
}): GenericContainer {
  const container = new GenericContainer(seaweedFsS3Image)
    .withCommand([
      "server",
      "-ip=127.0.0.1",
      "-dir=/data",
      "-s3",
      "-s3.port=9000",
      "-s3.ip.bind=0.0.0.0",
      "-s3.port.iceberg=0",
      "-s3.port.lance=0",
      "-master.volumeSizeLimitMB=1024",
      "-master.telemetry=false",
      ...(credentials ? ["-s3.config=/tmp/s3-test-identity.json"] : []),
    ])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server/));
  if (credentials) {
    const archive = new TarArchive();
    archive.append(
      JSON.stringify({
        identities: [
          {
            name: "storage-test",
            credentials: [
              { accessKey: credentials.accessKeyId, secretKey: credentials.secretAccessKey },
            ],
            actions: ["Admin", "Read", "Write", "List", "Tagging"],
          },
        ],
      }),
      { name: "tmp/s3-test-identity.json" },
    );
    // Testcontainers' content-copy helper still uses archiver 7's removed factory.
    // Its public tar input works with the workspace's archiver 8 security override.
    container.withCopyArchivesToContainer([{ tar: archive, target: "/" }]);
    void archive.finalize();
  }
  return container;
}
