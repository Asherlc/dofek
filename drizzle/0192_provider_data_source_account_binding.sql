ALTER TABLE fitness.provider_data_generation
ADD COLUMN source_account_digest text,
ADD COLUMN source_account_generation bigint,
ADD CONSTRAINT provider_data_generation_source_account_pair CHECK (
  (source_account_digest IS NULL) = (source_account_generation IS NULL)
) NOT VALID;

ALTER TABLE fitness.provider_data_generation
VALIDATE CONSTRAINT provider_data_generation_source_account_pair;
