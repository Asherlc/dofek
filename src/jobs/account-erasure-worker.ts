import type { ConnectionOptions } from "bullmq";
import { UnrecoverableError, Worker } from "bullmq";
import type { Database } from "../db/index.ts";
import type { AccountErasurePhaseRunner } from "./process-account-erasure-request.ts";
import { processAccountErasureRequest } from "./process-account-erasure-request.ts";
import {
  ACCOUNT_ERASURE_QUEUE,
  type AccountErasureJobData,
  accountErasureJobDataSchema,
} from "./queues.ts";

export interface AccountErasureWorkerOptions {
  connection: ConnectionOptions;
  prefix?: string;
}

export function createAccountErasureWorker(
  database: Pick<Database, "execute" | "transaction">,
  leaseOwner: string,
  phaseRunner: AccountErasurePhaseRunner,
  options: AccountErasureWorkerOptions,
): Worker<AccountErasureJobData> {
  return new Worker<AccountErasureJobData>(
    ACCOUNT_ERASURE_QUEUE,
    (job) => {
      let data: AccountErasureJobData;
      try {
        data = accountErasureJobDataSchema.parse(job.data);
      } catch {
        throw new UnrecoverableError("Invalid account erasure job payload");
      }
      return processAccountErasureRequest(database, data.requestId, leaseOwner, phaseRunner);
    },
    {
      autorun: false,
      concurrency: 1,
      connection: options.connection,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );
}
