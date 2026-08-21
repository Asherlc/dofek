ALTER TABLE fitness.provider_data_deletion_outbox
ADD COLUMN failure_reason text;

ALTER TABLE fitness.provider_data_deletion_outbox
ADD COLUMN failed_at timestamptz;

ALTER TABLE fitness.provider_data_deletion_outbox
DROP CONSTRAINT provider_data_deletion_outbox_status_valid;

ALTER TABLE fitness.provider_data_deletion_outbox
ADD CONSTRAINT provider_data_deletion_outbox_status_valid
CHECK (status IN ('pending', 'dispatched', 'completed', 'failed')) NOT VALID;

ALTER TABLE fitness.provider_data_deletion_outbox
VALIDATE CONSTRAINT provider_data_deletion_outbox_status_valid;
