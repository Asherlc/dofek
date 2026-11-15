ALTER TABLE fitness.sport_settings
  ADD COLUMN ftp integer,
  ADD CONSTRAINT sport_settings_ftp_positive CHECK (ftp IS NULL OR ftp > 0);
