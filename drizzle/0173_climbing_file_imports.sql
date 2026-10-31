ALTER TABLE fitness.file_upload
DROP CONSTRAINT file_upload_import_type_valid;
--> statement-breakpoint
ALTER TABLE fitness.file_upload
ADD CONSTRAINT file_upload_import_type_valid
CHECK (
  import_type IN (
    'apple-health', 'strong-csv', 'cronometer-csv', 'kaya-export',
    'crimpd', 'eight-a', 'moonboard', 'zos-app', 'garmin-dump', 'fit-file'
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.file_upload
VALIDATE CONSTRAINT file_upload_import_type_valid;
