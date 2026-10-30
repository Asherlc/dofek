{% macro activity_step_cadence_repair_ids() -%}
    {%- set activity_ids = var('activity_step_cadence_repair_activity_ids') -%}
    {%- if not activity_refresh_scope_enabled() -%}
        {{ exceptions.raise_compiler_error('exact cadence repair requires an ordinary user/activity refresh scope') }}
    {%- endif -%}
    {%- if activity_ids is not sequence or activity_ids is string or activity_ids is mapping or activity_ids | length > 100 -%}
        {{ exceptions.raise_compiler_error('exact cadence repair requires an array of at most 100 UUIDs') }}
    {%- endif -%}
    {%- set uuid_pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -%}
    {%- for activity_id in activity_ids + [var('activity_refresh_user_id')] -%}
        {%- if activity_id is not string or activity_id | length != 36 or not modules.re.match(uuid_pattern, activity_id) -%}
            {{ exceptions.raise_compiler_error('exact cadence repair requires valid user and activity UUIDs') }}
        {%- endif -%}
    {%- endfor -%}
    {%- if activity_ids | length == 0 -%}
        CAST([], 'Array(UUID)')
    {%- else -%}
        [
        {%- for activity_id in activity_ids -%}
            toUUID('{{ activity_id }}'){% if not loop.last %}, {% endif %}
        {%- endfor -%}
        ]
    {%- endif -%}
{%- endmacro %}
