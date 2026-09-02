UPDATE fitness.mcp_access_token
SET scopes = array_remove(scopes, 'nutrition:write')
WHERE 'nutrition:write' = any(scopes);
