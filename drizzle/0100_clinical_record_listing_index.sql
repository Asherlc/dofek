CREATE INDEX clinical_record_user_downloaded_id_idx
ON fitness.clinical_record (user_id, downloaded_at, id);
--> statement-breakpoint
DROP TYPE fitness.lab_result_status;
