-- Drop the old Postgres activity-rollup projection. It depended on
-- fitness.deduped_sensor and fitness.activity_summary, which were replaced by
-- ClickHouse analytics.deduped_sensor and analytics.activity_summary.

DROP TRIGGER IF EXISTS metric_stream_activity_rollup_dirty_insert ON fitness.metric_stream;

--> statement-breakpoint

DROP TRIGGER IF EXISTS metric_stream_activity_rollup_dirty_delete ON fitness.metric_stream;

--> statement-breakpoint

DROP TRIGGER IF EXISTS metric_stream_activity_rollup_dirty_update ON fitness.metric_stream;

--> statement-breakpoint

DROP TRIGGER IF EXISTS activity_rollup_dirty_update ON fitness.activity;

--> statement-breakpoint

DROP TRIGGER IF EXISTS activity_training_summary_delete ON fitness.activity;

--> statement-breakpoint

DROP FUNCTION IF EXISTS analytics.refresh_activity_training_summary(uuid);

--> statement-breakpoint

DROP FUNCTION IF EXISTS analytics.refresh_dirty_activity_training_summaries(integer);

--> statement-breakpoint

DROP FUNCTION IF EXISTS analytics.mark_activity_rollup_dirty_from_metric_stream_insert();

--> statement-breakpoint

DROP FUNCTION IF EXISTS analytics.mark_activity_rollup_dirty_from_metric_stream_delete();

--> statement-breakpoint

DROP FUNCTION IF EXISTS analytics.mark_activity_rollup_dirty_from_metric_stream_update();

--> statement-breakpoint

DROP FUNCTION IF EXISTS analytics.mark_activity_rollup_dirty_from_activity_update();

--> statement-breakpoint

DROP FUNCTION IF EXISTS analytics.delete_activity_training_summary_from_activity_delete();

--> statement-breakpoint

DROP TABLE IF EXISTS analytics.activity_rollup_dirty;

--> statement-breakpoint

DROP TABLE IF EXISTS analytics.activity_training_summary;
