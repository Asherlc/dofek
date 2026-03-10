ALTER TABLE "fitness"."daily_metrics" DROP CONSTRAINT "daily_metrics_date_provider_id_sport_pk";--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" ADD CONSTRAINT "daily_metrics_date_provider_id_pk" PRIMARY KEY("date","provider_id");--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" DROP COLUMN "sport";--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" DROP COLUMN "ctl";--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" DROP COLUMN "atl";--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" DROP COLUMN "tsb";--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" DROP COLUMN "eftp";--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" DROP COLUMN "sleep_score";--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" DROP COLUMN "readiness";