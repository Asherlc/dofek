{% macro activity_refresh_scope_enabled() -%}
    {%- set payload = var('activity_refresh_activity_ids_base64', none) -%}
    {%- set user_id = var('activity_refresh_user_id', none) -%}
    {%- if payload is none and user_id is none -%}
        {{ return(false) }}
    {%- endif -%}
    {%- if payload is not string or user_id is not string -%}
        {{ exceptions.raise_compiler_error('activity refresh scope requires packed activity ids and user id together') }}
    {%- endif -%}
    {%- set uuid_pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -%}
    {%- if user_id | length != 36 or not modules.re.match(uuid_pattern, user_id) -%}
        {{ exceptions.raise_compiler_error('activity refresh scope requires a valid user UUID') }}
    {%- endif -%}
    {# Canonical padding bits, alphabet and complete quartets; no whitespace or URL-safe variants. #}
    {%- set base64_pattern = '(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)?' -%}
    {%- if not modules.re.fullmatch(base64_pattern, payload) -%}
        {{ exceptions.raise_compiler_error('activity refresh scope requires canonical base64') }}
    {%- endif -%}
    {%- set padding = 2 if payload.endswith('==') else (1 if payload.endswith('=') else 0) -%}
    {%- set byte_count = (payload | length // 4) * 3 - padding -%}
    {%- if byte_count == 0 or byte_count % 16 != 0 or byte_count > 160000 -%}
        {{ exceptions.raise_compiler_error('activity refresh scope requires 1 to 10000 packed 16-byte UUIDs') }}
    {%- endif -%}
    {{ return(true) }}
{%- endmacro %}

{% macro activity_refresh_requested_id_ctes() %}
    base64Decode('{{ var("activity_refresh_activity_ids_base64") }}') AS dofek_refresh_uuid_bytes,
    arrayMap(
        i -> toUUID(UUIDNumToString(toFixedString(
            substring(dofek_refresh_uuid_bytes, 1 + 16 * i, 16), 16
        ), 1)),
        range(intDiv(length(dofek_refresh_uuid_bytes), 16))
    ) AS dofek_refresh_requested_ids,
{% endmacro %}

{% macro activity_refresh_scope_ctes() %}
    {{ activity_refresh_requested_id_ctes() }}
    arrayDistinct(arrayConcat(
        {{ activity_refresh_requested_ids() }},
        {{ apple_health_workout_refresh_ids() }}
    )) AS dofek_refresh_ids,
{% endmacro %}

{% macro activity_refresh_requested_ids() -%}
    dofek_refresh_requested_ids
{%- endmacro %}

{% macro activity_refresh_ids() -%}
    dofek_refresh_ids
{%- endmacro %}
