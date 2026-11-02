-- dofek: deployment-mode=maintenance
ALTER TABLE fitness.sport_settings DROP COLUMN ftp;
--> statement-breakpoint
DROP VIEW clickhouse.user_profile;
--> statement-breakpoint
ALTER TABLE fitness.user_profile DROP COLUMN ftp;
--> statement-breakpoint
CREATE VIEW clickhouse.user_profile AS
SELECT id, max_hr, resting_hr, birth_date
FROM fitness.user_profile;
