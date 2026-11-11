-- Only explicit source metadata and a valid upstream identifier establish a copy.
CREATE OR REPLACE FUNCTION fitness.activity_copy_identity(
  input_provider_id text, input_external_id text, input_raw jsonb
)
RETURNS TABLE (provider_id text, external_id text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
SELECT 'whoop'::text, LOWER(REPLACE(input_external_id, '-', ''))
WHERE input_provider_id = 'peloton'
  AND LOWER(TRIM(input_raw ->> 'platform')) = 'whoop'
  AND LOWER(TRIM(input_raw ->> 'deviceType')) = 'whoop'
  AND LOWER(input_external_id) ~ '^([0-9a-f]{32}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$';
$$;
