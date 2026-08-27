UPDATE fitness.mcp_access_token
SET scopes = array_remove(scopes, 'nutrition:write');
--> statement-breakpoint

UPDATE fitness.mcp_oauth_authorization_code
SET scopes = array_remove(scopes, 'nutrition:write');
--> statement-breakpoint

UPDATE fitness.mcp_oauth_refresh_token
SET scopes = array_remove(scopes, 'nutrition:write');
