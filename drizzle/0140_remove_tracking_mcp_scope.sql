UPDATE fitness.mcp_access_token
SET scopes = array_remove(scopes, 'health:write')
WHERE 'health:write' = any(scopes);
--> statement-breakpoint
UPDATE fitness.mcp_oidc_adapter AS adapter
SET
  payload = jsonb_set(adapter.payload, '{scope}', to_jsonb(coalesce((
    SELECT string_agg(tokens.scope, ' ' ORDER BY tokens.position)
    FROM
      regexp_split_to_table(adapter.payload ->> 'scope', '\s+')
      WITH ORDINALITY AS tokens (scope, position)
    WHERE tokens.scope <> 'health:write'
  ), '')))
WHERE adapter.payload ->> 'scope' ~ '(^|\s)health:write(\s|$)';
--> statement-breakpoint
UPDATE fitness.mcp_oidc_adapter AS adapter
SET
  payload = jsonb_set(adapter.payload, '{resources}', (
    SELECT
      jsonb_object_agg(resources.resource, (
        SELECT coalesce(string_agg(tokens.scope, ' ' ORDER BY tokens.position), '')
        FROM
          regexp_split_to_table(resources.scopes, '\s+')
          WITH ORDINALITY AS tokens (scope, position)
        WHERE tokens.scope <> 'health:write'
      ))
    FROM jsonb_each_text(adapter.payload -> 'resources') AS resources (resource, scopes)
  ))
WHERE
  jsonb_typeof(adapter.payload -> 'resources') = 'object'
  AND EXISTS (
    SELECT 1
    FROM jsonb_each_text(adapter.payload -> 'resources') AS resources (resource, scopes)
    WHERE resources.scopes ~ '(^|\s)health:write(\s|$)'
  );
--> statement-breakpoint
UPDATE fitness.mcp_oidc_adapter AS adapter
SET
  payload = jsonb_set(adapter.payload, '{openid,scope}', to_jsonb(coalesce((
    SELECT string_agg(tokens.scope, ' ' ORDER BY tokens.position)
    FROM
      regexp_split_to_table(adapter.payload #>> '{openid,scope}', '\s+')
      WITH ORDINALITY AS tokens (scope, position)
    WHERE tokens.scope <> 'health:write'
  ), '')))
WHERE adapter.payload #>> '{openid,scope}' ~ '(^|\s)health:write(\s|$)';
