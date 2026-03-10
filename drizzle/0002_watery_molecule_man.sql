ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "vo2max" real;--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "spo2_avg" real;--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "respiratory_rate_avg" real;--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "steps" integer;--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "active_energy_kcal" real;--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" ADD COLUMN "basal_energy_kcal" real;--> statement-breakpoint
ALTER TABLE "fitness"."metric_stream" ADD COLUMN "spo2" real;--> statement-breakpoint
ALTER TABLE "fitness"."metric_stream" ADD COLUMN "respiratory_rate" real;