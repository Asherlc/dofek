-- Re-add the TimescaleDB compression policy for fitness.metric_stream.
--
-- The policy was defined in 0000_baseline.sql (compress_after => 7 days) but is
-- absent on production: there was no policy_compression job, so 2022 daily
-- chunks (~80 GB of raw sensor data) were never compressed and filled the data
-- volume, which in turn broke PeerDB CDC (MinIO returned HTTP 507). Compression
-- is still enabled on the hypertable (compress_segmentby/orderby set in the
-- baseline), so we only need to (re)create the scheduling policy.
--
-- compress_after is tightened from 7 days to 2 days: metric_stream now ingests
-- several GB/day, so keeping a full week uncompressed is too much headroom on
-- the volume. Two days leaves the current and previous day's chunks hot for
-- late-arriving writes while compressing everything older. CDC is unaffected —
-- logical decoding reads insert events from WAL, not from the chunks.
--
-- if_not_exists keeps this idempotent and a no-op where the policy already
-- exists (e.g. a freshly provisioned Oracle host created from the baseline).
SELECT public.add_compression_policy(
  'fitness.metric_stream',
  compress_after => INTERVAL '2 days',
  if_not_exists => true
);
