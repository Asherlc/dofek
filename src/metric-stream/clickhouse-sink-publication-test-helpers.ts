import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";

/** Runs the real environment entrypoint; MSW delays only its first fence response. */
export function startPublicationSink(input: {
  connectionString: string;
  topic: string;
  groupId: string;
  holdFence: boolean;
}) {
  const script = `
    import {bypass,http,passthrough} from 'msw';
    import {setupServer} from 'msw/node';
    import {runMetricStreamClickHouseSinkFromEnv} from './src/metric-stream/clickhouse-sink.ts';
    import {MetricStreamConsumerReadiness} from './src/metric-stream/consumer-readiness.ts';
    import {ACCOUNT_ERASURE_FENCE_TABLE} from './src/metric-stream/clickhouse-table.ts';
    let release;
    const held=new Promise(resolve=>{release=resolve;});
    process.on('message',message=>{if(message==='release-fence')release();});
    let delayed=false;
    const server=setupServer(http.post('*',async ({request})=>{
      if(new URL(request.url).origin!==new URL(process.env.CLICKHOUSE_URL).origin)return passthrough();
      const query=new URL(request.url).searchParams.get('query')??await request.clone().text();
      if(process.argv[1]==='hold'&&!delayed&&query.includes(ACCOUNT_ERASURE_FENCE_TABLE)&&query.trimStart().startsWith('SELECT')) {
        delayed=true;
        const headers=new Headers(request.headers);
        // Fetch owns the forwarded body framing; the native HTTP client's
        // hop-by-hop chunked header is forbidden by Undici.
        headers.delete('transfer-encoding');
        const response=await fetch(bypass(request,{headers}));
        process.send('fence-read');
        await held;
        return response;
      }
      return passthrough();
    }));
    server.listen({onUnhandledRequest:'bypass'});
    await runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness());
    process.send('started');
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, input.holdFence ? "hold" : "pass"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: input.connectionString,
        METRIC_STREAM_TOPIC: input.topic,
        METRIC_STREAM_CONSUMER_GROUP: input.groupId,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let fenceRead = false,
    started = false;
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-8192);
    });
  child.on("message", (message) => {
    if (message === "started") started = true;
    if (message === "fence-read") fenceRead = true;
  });
  const exited = once(child, "exit");
  const observe = async (ready: () => boolean, timeout: number) =>
    vi.waitFor(
      () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Sink exited before fixture completed: ${output}`);
        expect(ready(), output).toBe(true);
      },
      { timeout },
    );
  return {
    get started() {
      return observe(() => started, 60000);
    },
    get fenceRead() {
      return observe(() => fenceRead, 10000);
    },
    releaseFence() {
      if (child.connected) child.send("release-fence");
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}
