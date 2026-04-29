import { logger } from "../logger.ts";
import { syncClickHouseMetricStreamFromEnv } from "./clickhouse.ts";

const syncedRows = await syncClickHouseMetricStreamFromEnv();
logger.info(`[clickhouse] Synced ${syncedRows} metric_stream row(s)`);
