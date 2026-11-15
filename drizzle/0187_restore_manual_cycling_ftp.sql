ALTER TABLE fitness.sport_settings
ADD COLUMN ftp bigint;
--> statement-breakpoint
ALTER TABLE fitness.sport_settings
ADD CONSTRAINT sport_settings_ftp_positive CHECK (ftp IS NULL OR ftp > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.sport_settings VALIDATE CONSTRAINT sport_settings_ftp_positive;
