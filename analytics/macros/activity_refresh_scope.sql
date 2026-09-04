{% macro activity_refresh_scope_enabled() -%}
    {%- set activity_ids = var('activity_refresh_activity_ids', none) -%}
    {%- set user_id = var('activity_refresh_user_id', none) -%}
    {%- set activity_ids_provided = activity_ids is not none and activity_ids | length > 0 -%}
    {%- set user_id_provided = user_id is not none and user_id | string | trim | length > 0 -%}
    {%- set provided = [activity_ids_provided, user_id_provided] | select('equalto', true) | list | length -%}
    {%- if provided not in [0, 2] -%}
        {{ exceptions.raise_compiler_error('activity refresh scope requires activity ids and user id together') }}
    {%- endif -%}
    {{ return(provided == 2) }}
{%- endmacro %}

{% macro activity_refresh_ids() -%}
    {%- set activity_ids = var('activity_refresh_activity_ids') -%}
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
