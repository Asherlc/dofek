UPDATE fitness.mcp_oauth_authorization_code
SET scopes = array_remove(scopes, 'nutrition:write')
WHERE 'nutrition:write' = any(scopes);
--> statement-breakpoint

UPDATE fitness.mcp_oauth_refresh_token
SET scopes = array_remove(scopes, 'nutrition:write')
WHERE 'nutrition:write' = any(scopes);
