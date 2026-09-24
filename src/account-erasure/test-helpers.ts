import { GenericContainer, Wait } from "testcontainers";

/** Digest-pinned SeaweedFS release used as the S3-compatible stand-in for local/CI. */
export const seaweedFsS3Image =
  "chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882";

/** Single-node SeaweedFS with the S3 API on port 9000 (path-style). */
export function createSeaweedFsS3Container(credentials: {
  accessKeyId: string;
  secretAccessKey: string;
}): GenericContainer {
  const s3Config = JSON.stringify({
    identities: [
      {
        actions: ["Admin", "Read", "Write", "List", "Tagging"],
        credentials: [
          {
            accessKey: credentials.accessKeyId,
            secretKey: credentials.secretAccessKey,
          },
        ],
        name: credentials.accessKeyId,
      },
    ],
  });
  return new GenericContainer(seaweedFsS3Image)
    .withCopyContentToContainer([
      {
        content: s3Config,
        target: "/etc/seaweedfs/s3.json",
      },
    ])
    .withCommand([
      "server",
      "-ip=127.0.0.1",
      "-dir=/data",
      "-s3",
      "-s3.port=9000",
      "-s3.ip.bind=0.0.0.0",
      "-s3.config=/etc/seaweedfs/s3.json",
      "-master.volumeSizeLimitMB=1024",
      "-master.telemetry=false",
    ])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server/));
}
