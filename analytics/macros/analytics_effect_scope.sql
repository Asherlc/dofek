{% macro analytics_effect_scope(stage) %}
analytics_effects AS (
    SELECT arrayJoin(CAST([
        {% for source_id in var('analytics_source_ids') %}
            toUUID(unhex('{{ source_id.encode("utf-8").hex() }}')){% if not loop.last %},{% endif %}
        {% endfor %}
    ], 'Array(UUID)')) AS source_id
),
analytics_keys AS (
    SELECT key.1 AS user_id, key.2 AS channel, key.3 AS recorded_at
    FROM (
        SELECT arrayJoin(CAST([
            {% for key in var('analytics_keys') %}
                tuple(toUUID(unhex('{{ key.userId.encode("utf-8").hex() }}')),
                    unhex('{{ key.channel.encode("utf-8").hex() }}'),
                    parseDateTime64BestEffort(unhex('{{ key.recordedAt.encode("utf-8").hex() }}'), 9, 'UTC')){% if not loop.last %},{% endif %}
            {% endfor %}
        ], 'Array(Tuple(UUID, String, DateTime64(9)))')) AS key
    )
),
{% endmacro %}
