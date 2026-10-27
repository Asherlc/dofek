CREATE UNIQUE INDEX climbing_entry_openbeta_external_id_idx
ON fitness.climbing_entry (user_id, provider_id, external_id)
WHERE provider_id = 'openbeta' AND external_id IS NOT NULL;
