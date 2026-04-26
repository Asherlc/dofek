--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: timescaledb; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;


--
-- Name: EXTENSION timescaledb; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION timescaledb IS 'Enables scalable inserts and complex queries for time-series data (Community Edition)';


--
-- Name: fitness; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA fitness;


--
-- Name: health; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA health;


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA health;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: activity_type; Type: TYPE; Schema: fitness; Owner: -
--

CREATE TYPE fitness.activity_type AS ENUM (
    'cycling',
    'road_cycling',
    'mountain_biking',
    'gravel_cycling',
    'indoor_cycling',
    'virtual_cycling',
    'e_bike_cycling',
    'cyclocross',
    'track_cycling',
    'bmx',
    'running',
    'trail_running',
    'swimming',
    'open_water_swimming',
    'walking',
    'hiking',
    'strength',
    'strength_training',
    'functional_strength',
    'gym',
    'yoga',
    'pilates',
    'tai_chi',
    'mind_and_body',
    'meditation',
    'breathwork',
    'stretching',
    'flexibility',
    'barre',
    'elliptical',
    'rowing',
    'cardio',
    'hiit',
    'mixed_cardio',
    'mixed_metabolic_cardio',
    'stair_climbing',
    'stairmaster',
    'stairs',
    'step_training',
    'jump_rope',
    'fitness_gaming',
    'cross_training',
    'bootcamp',
    'circuit_training',
    'functional_fitness',
    'core',
    'core_training',
    'boxing',
    'kickboxing',
    'martial_arts',
    'group_exercise',
    'skiing',
    'cross_country_skiing',
    'downhill_skiing',
    'snowboarding',
    'snow_sports',
    'snowshoeing',
    'skating',
    'surfing',
    'kayaking',
    'sailing',
    'paddle_sports',
    'paddleboarding',
    'paddling',
    'water_fitness',
    'water_polo',
    'water_sports',
    'aqua_fitness',
    'underwater_diving',
    'diving',
    'snorkeling',
    'tennis',
    'table_tennis',
    'squash',
    'racquetball',
    'badminton',
    'pickleball',
    'padel',
    'paddle_racquet',
    'basketball',
    'soccer',
    'football',
    'american_football',
    'australian_football',
    'rugby',
    'hockey',
    'ice_hockey',
    'lacrosse',
    'baseball',
    'softball',
    'volleyball',
    'cricket',
    'handball',
    'golf',
    'disc_golf',
    'climbing',
    'rock_climbing',
    'dance',
    'dancing',
    'cardio_dance',
    'social_dance',
    'triathlon',
    'multisport',
    'hand_cycling',
    'wheelchair_walk',
    'wheelchair_run',
    'disc_sports',
    'equestrian',
    'fencing',
    'fishing',
    'hunting',
    'gymnastics',
    'archery',
    'bowling',
    'curling',
    'wrestling',
    'track_and_field',
    'play',
    'navigation',
    'geocaching',
    'skydiving',
    'paragliding',
    'preparation_and_recovery',
    'cooldown',
    'transition',
    'other'
);


--
-- Name: food_category; Type: TYPE; Schema: fitness; Owner: -
--

CREATE TYPE fitness.food_category AS ENUM (
    'beans_and_legumes',
    'beverages',
    'breads_and_cereals',
    'cheese_milk_and_dairy',
    'eggs',
    'fast_food',
    'fish_and_seafood',
    'fruit',
    'meat',
    'nuts_and_seeds',
    'pasta_rice_and_noodles',
    'salads',
    'sauces_spices_and_spreads',
    'snacks',
    'soups',
    'sweets_candy_and_desserts',
    'vegetables',
    'supplement',
    'other'
);


--
-- Name: lab_result_status; Type: TYPE; Schema: fitness; Owner: -
--

CREATE TYPE fitness.lab_result_status AS ENUM (
    'final',
    'preliminary',
    'corrected',
    'cancelled'
);


--
-- Name: meal; Type: TYPE; Schema: fitness; Owner: -
--

CREATE TYPE fitness.meal AS ENUM (
    'breakfast',
    'lunch',
    'dinner',
    'snack',
    'other'
);


--
-- Name: set_type; Type: TYPE; Schema: fitness; Owner: -
--

CREATE TYPE fitness.set_type AS ENUM (
    'working',
    'warmup',
    'dropset',
    'failure'
);


--
-- Name: sleep_stage_name; Type: TYPE; Schema: fitness; Owner: -
--

CREATE TYPE fitness.sleep_stage_name AS ENUM (
    'deep',
    'light',
    'rem',
    'awake'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _compressed_hypertable_3; Type: TABLE; Schema: _timescaledb_internal; Owner: -
--

CREATE TABLE _timescaledb_internal._compressed_hypertable_3 (
);


--
-- Name: metric_stream; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.metric_stream (
    recorded_at timestamp with time zone CONSTRAINT sensor_sample_recorded_at_not_null NOT NULL,
    user_id uuid CONSTRAINT sensor_sample_user_id_not_null NOT NULL,
    provider_id text CONSTRAINT sensor_sample_provider_id_not_null NOT NULL,
    device_id text,
    source_type text CONSTRAINT sensor_sample_source_type_not_null NOT NULL,
    channel text CONSTRAINT sensor_sample_channel_not_null NOT NULL,
    activity_id uuid,
    scalar real,
    vector real[]
);


--
-- Name: _direct_view_10; Type: VIEW; Schema: _timescaledb_internal; Owner: -
--

CREATE VIEW _timescaledb_internal._direct_view_10 AS
 SELECT public.time_bucket('1 day'::interval, recorded_at) AS bucket,
    user_id,
    channel,
    (avg(scalar))::real AS avg_value,
    max(scalar) AS max_value,
    min(scalar) AS min_value,
    (count(*))::integer AS sample_count
   FROM fitness.metric_stream
  WHERE ((scalar IS NOT NULL) AND (activity_id IS NOT NULL))
  GROUP BY (public.time_bucket('1 day'::interval, recorded_at)), user_id, channel;


--
-- Name: _materialized_hypertable_10; Type: TABLE; Schema: _timescaledb_internal; Owner: -
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_10 (
    bucket timestamp with time zone NOT NULL,
    user_id uuid,
    channel text,
    avg_value real,
    max_value real,
    min_value real,
    sample_count integer
);


--
-- Name: cagg_sensor_daily; Type: VIEW; Schema: fitness; Owner: -
--

CREATE VIEW fitness.cagg_sensor_daily AS
 SELECT bucket,
    user_id,
    channel,
    avg_value,
    max_value,
    min_value,
    sample_count
   FROM _timescaledb_internal._materialized_hypertable_10;


--
-- Name: _direct_view_11; Type: VIEW; Schema: _timescaledb_internal; Owner: -
--

CREATE VIEW _timescaledb_internal._direct_view_11 AS
 SELECT public.time_bucket('7 days'::interval, bucket) AS bucket,
    user_id,
    channel,
    (sum((avg_value * (sample_count)::double precision)) / (NULLIF(sum(sample_count), 0))::real) AS avg_value,
    max(max_value) AS max_value,
    min(min_value) AS min_value,
    (sum(sample_count))::integer AS sample_count
   FROM fitness.cagg_sensor_daily
  GROUP BY (public.time_bucket('7 days'::interval, bucket)), user_id, channel;


--
-- Name: _materialized_hypertable_3; Type: TABLE; Schema: _timescaledb_internal; Owner: -
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_3 (
    bucket timestamp with time zone NOT NULL,
    user_id uuid,
    avg_hr real,
    max_hr smallint,
    min_hr smallint,
    avg_power real,
    max_power smallint,
    avg_cadence real,
    avg_speed real,
    max_speed real,
    max_altitude real,
    min_altitude real,
    total_samples integer,
    hr_samples integer,
    power_samples integer,
    cadence_samples integer,
    activity_count integer
);


--
-- Name: cagg_metric_daily; Type: VIEW; Schema: fitness; Owner: -
--

CREATE VIEW fitness.cagg_metric_daily AS
 SELECT bucket,
    user_id,
    avg_hr,
    max_hr,
    min_hr,
    avg_power,
    max_power,
    avg_cadence,
    avg_speed,
    max_speed,
    max_altitude,
    min_altitude,
    total_samples,
    hr_samples,
    power_samples,
    cadence_samples,
    activity_count
   FROM _timescaledb_internal._materialized_hypertable_3;


--
-- Name: _direct_view_4; Type: VIEW; Schema: _timescaledb_internal; Owner: -
--

CREATE VIEW _timescaledb_internal._direct_view_4 AS
 SELECT public.time_bucket('7 days'::interval, bucket) AS bucket,
    user_id,
    (sum((avg_hr * (hr_samples)::double precision)) / (NULLIF(sum(hr_samples), 0))::real) AS avg_hr,
    max(max_hr) AS max_hr,
    min(min_hr) AS min_hr,
    (sum((avg_power * (power_samples)::double precision)) / (NULLIF(sum(power_samples), 0))::real) AS avg_power,
    max(max_power) AS max_power,
    (sum((avg_cadence * (cadence_samples)::double precision)) / (NULLIF(sum(cadence_samples), 0))::real) AS avg_cadence,
    (sum((avg_speed * (total_samples)::double precision)) / (NULLIF(sum(total_samples), 0))::real) AS avg_speed,
    max(max_speed) AS max_speed,
    max(max_altitude) AS max_altitude,
    min(min_altitude) AS min_altitude,
    (sum(total_samples))::integer AS total_samples,
    (sum(hr_samples))::integer AS hr_samples,
    (sum(power_samples))::integer AS power_samples,
    (sum(cadence_samples))::integer AS cadence_samples,
    (sum(activity_count))::integer AS activity_count
   FROM fitness.cagg_metric_daily
  GROUP BY (public.time_bucket('7 days'::interval, bucket)), user_id;


--
-- Name: _materialized_hypertable_11; Type: TABLE; Schema: _timescaledb_internal; Owner: -
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_11 (
    bucket timestamp with time zone NOT NULL,
    user_id uuid,
    channel text,
    avg_value double precision,
    max_value real,
    min_value real,
    sample_count integer
);


--
-- Name: _materialized_hypertable_4; Type: TABLE; Schema: _timescaledb_internal; Owner: -
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_4 (
    bucket timestamp with time zone NOT NULL,
    user_id uuid,
    avg_hr double precision,
    max_hr smallint,
    min_hr smallint,
    avg_power double precision,
    max_power smallint,
    avg_cadence double precision,
    avg_speed double precision,
    max_speed real,
    max_altitude real,
    min_altitude real,
    total_samples integer,
    hr_samples integer,
    power_samples integer,
    cadence_samples integer,
    activity_count integer
);


--
-- Name: _partial_view_10; Type: VIEW; Schema: _timescaledb_internal; Owner: -
--

CREATE VIEW _timescaledb_internal._partial_view_10 AS
 SELECT public.time_bucket('1 day'::interval, recorded_at) AS bucket,
    user_id,
    channel,
    (avg(scalar))::real AS avg_value,
    max(scalar) AS max_value,
    min(scalar) AS min_value,
    (count(*))::integer AS sample_count
   FROM fitness.metric_stream
  WHERE ((scalar IS NOT NULL) AND (activity_id IS NOT NULL))
  GROUP BY (public.time_bucket('1 day'::interval, recorded_at)), user_id, channel;


--
-- Name: _partial_view_11; Type: VIEW; Schema: _timescaledb_internal; Owner: -
--

CREATE VIEW _timescaledb_internal._partial_view_11 AS
 SELECT public.time_bucket('7 days'::interval, bucket) AS bucket,
    user_id,
    channel,
    (sum((avg_value * (sample_count)::double precision)) / (NULLIF(sum(sample_count), 0))::real) AS avg_value,
    max(max_value) AS max_value,
    min(min_value) AS min_value,
    (sum(sample_count))::integer AS sample_count
   FROM fitness.cagg_sensor_daily
  GROUP BY (public.time_bucket('7 days'::interval, bucket)), user_id, channel;


--
-- Name: _partial_view_4; Type: VIEW; Schema: _timescaledb_internal; Owner: -
--

CREATE VIEW _timescaledb_internal._partial_view_4 AS
 SELECT public.time_bucket('7 days'::interval, bucket) AS bucket,
    user_id,
    (sum((avg_hr * (hr_samples)::double precision)) / (NULLIF(sum(hr_samples), 0))::real) AS avg_hr,
    max(max_hr) AS max_hr,
    min(min_hr) AS min_hr,
    (sum((avg_power * (power_samples)::double precision)) / (NULLIF(sum(power_samples), 0))::real) AS avg_power,
    max(max_power) AS max_power,
    (sum((avg_cadence * (cadence_samples)::double precision)) / (NULLIF(sum(cadence_samples), 0))::real) AS avg_cadence,
    (sum((avg_speed * (total_samples)::double precision)) / (NULLIF(sum(total_samples), 0))::real) AS avg_speed,
    max(max_speed) AS max_speed,
    max(max_altitude) AS max_altitude,
    min(min_altitude) AS min_altitude,
    (sum(total_samples))::integer AS total_samples,
    (sum(hr_samples))::integer AS hr_samples,
    (sum(power_samples))::integer AS power_samples,
    (sum(cadence_samples))::integer AS cadence_samples,
    (sum(activity_count))::integer AS activity_count
   FROM fitness.cagg_metric_daily
  GROUP BY (public.time_bucket('7 days'::interval, bucket)), user_id;


--
-- Name: activity; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    external_id text,
    activity_type fitness.activity_type NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    raw jsonb,
    name text,
    user_id uuid NOT NULL,
    perceived_exertion real,
    source_name text,
    timezone text,
    strava_id text
);


--
-- Name: activity_interval; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.activity_interval (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    activity_id uuid NOT NULL,
    interval_index integer NOT NULL,
    label text,
    interval_type text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device_priority; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.device_priority (
    provider_id text NOT NULL,
    source_name_pattern text NOT NULL,
    priority integer,
    sleep_priority integer,
    body_priority integer,
    recovery_priority integer,
    daily_activity_priority integer
);


--
-- Name: provider_priority; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.provider_priority (
    provider_id text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    sleep_priority integer,
    body_priority integer,
    recovery_priority integer,
    daily_activity_priority integer
);


--
-- Name: v_activity; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.v_activity AS
 WITH RECURSIVE ranked AS (
         SELECT a.id,
            a.provider_id,
            a.external_id,
            a.activity_type,
            a.started_at,
            a.ended_at,
            a.notes,
            a.created_at,
            a.raw,
            a.name,
            a.user_id,
            a.perceived_exertion,
            a.source_name,
            a.timezone,
            a.strava_id,
            COALESCE(dp.priority, pp.priority, 100) AS prio
           FROM ((fitness.activity a
             LEFT JOIN fitness.provider_priority pp ON ((pp.provider_id = a.provider_id)))
             LEFT JOIN LATERAL ( SELECT dp2.priority
                   FROM fitness.device_priority dp2
                  WHERE ((dp2.provider_id = a.provider_id) AND (a.source_name ~~ dp2.source_name_pattern))
                  ORDER BY (length(dp2.source_name_pattern)) DESC
                 LIMIT 1) dp ON (true))
        ), pairs AS (
         SELECT r1.id AS id1,
            r2.id AS id2
           FROM (ranked r1
             JOIN ranked r2 ON (((r1.user_id = r2.user_id) AND (r1.id < r2.id) AND ((EXTRACT(epoch FROM (LEAST(COALESCE(r1.ended_at, (r1.started_at + '01:00:00'::interval)), COALESCE(r2.ended_at, (r2.started_at + '01:00:00'::interval))) - GREATEST(r1.started_at, r2.started_at))) / NULLIF(EXTRACT(epoch FROM (GREATEST(COALESCE(r1.ended_at, (r1.started_at + '01:00:00'::interval)), COALESCE(r2.ended_at, (r2.started_at + '01:00:00'::interval))) - LEAST(r1.started_at, r2.started_at))), (0)::numeric)) > 0.8))))
        ), edges AS (
         SELECT pairs.id1 AS a,
            pairs.id2 AS b
           FROM pairs
        UNION ALL
         SELECT pairs.id2 AS a,
            pairs.id1 AS b
           FROM pairs
        ), clusters(activity_id, group_id) AS (
         SELECT ranked.id,
            (ranked.id)::text AS id
           FROM ranked
        UNION
         SELECT e.b,
            c.group_id
           FROM (edges e
             JOIN clusters c ON ((c.activity_id = e.a)))
        ), final_groups AS (
         SELECT clusters.activity_id,
            min(clusters.group_id) AS group_id
           FROM clusters
          GROUP BY clusters.activity_id
        ), best_per_group AS (
         SELECT DISTINCT ON (fg.group_id) fg.group_id,
            r.id AS canonical_id,
            r.provider_id,
            r.user_id,
            r.activity_type,
            r.started_at,
            r.ended_at,
            r.source_name,
            r.prio
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.activity_id)))
          ORDER BY fg.group_id, r.prio, r.id
        ), merged AS (
         SELECT b.canonical_id,
            b.provider_id,
            b.user_id,
            b.activity_type,
            b.started_at,
            b.ended_at,
            b.source_name,
            ( SELECT r.name
                   FROM (final_groups fg2
                     JOIN ranked r ON ((r.id = fg2.activity_id)))
                  WHERE ((fg2.group_id = b.group_id) AND (r.name IS NOT NULL))
                  ORDER BY r.prio
                 LIMIT 1) AS name,
            ( SELECT r.notes
                   FROM (final_groups fg2
                     JOIN ranked r ON ((r.id = fg2.activity_id)))
                  WHERE ((fg2.group_id = b.group_id) AND (r.notes IS NOT NULL))
                  ORDER BY r.prio
                 LIMIT 1) AS notes,
            ( SELECT r.timezone
                   FROM (final_groups fg2
                     JOIN ranked r ON ((r.id = fg2.activity_id)))
                  WHERE ((fg2.group_id = b.group_id) AND (r.timezone IS NOT NULL))
                  ORDER BY r.prio
                 LIMIT 1) AS timezone,
            ( SELECT jsonb_object_agg(sub.key, sub.value) AS jsonb_object_agg
                   FROM ( SELECT jsonb_each.key,
                            jsonb_each.value,
                            row_number() OVER (PARTITION BY jsonb_each.key ORDER BY r.prio) AS rn
                           FROM (final_groups fg2
                             JOIN ranked r ON ((r.id = fg2.activity_id))),
                            LATERAL jsonb_each(COALESCE(r.raw, '{}'::jsonb)) jsonb_each(key, value)
                          WHERE (fg2.group_id = b.group_id)) sub
                  WHERE (sub.rn = 1)) AS raw,
            ( SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id) AS array_agg
                   FROM (final_groups fg2
                     JOIN ranked r ON ((r.id = fg2.activity_id)))
                  WHERE (fg2.group_id = b.group_id)) AS source_providers,
            ( SELECT jsonb_agg(jsonb_build_object('providerId', r.provider_id, 'externalId', r.external_id) ORDER BY r.provider_id) AS jsonb_agg
                   FROM (final_groups fg2
                     JOIN ranked r ON ((r.id = fg2.activity_id)))
                  WHERE ((fg2.group_id = b.group_id) AND (r.external_id IS NOT NULL) AND (r.external_id <> ''::text))) AS source_external_ids,
            ( SELECT array_agg(fg2.activity_id ORDER BY fg2.activity_id) AS array_agg
                   FROM final_groups fg2
                  WHERE (fg2.group_id = b.group_id)) AS member_activity_ids
           FROM best_per_group b
        )
 SELECT canonical_id AS id,
    provider_id,
    user_id,
    canonical_id AS primary_activity_id,
    activity_type,
    started_at,
    ended_at,
    source_name,
    name,
    notes,
    timezone,
    raw,
    source_providers,
    source_external_ids,
    member_activity_ids
   FROM merged m
  ORDER BY started_at DESC
  WITH NO DATA;


--
-- Name: deduped_sensor; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.deduped_sensor AS
 WITH canonical_activities AS (
         SELECT a.id AS canonical_id,
            a.user_id,
            a.started_at,
            a.ended_at,
            a.member_activity_ids
           FROM fitness.v_activity a
        ), activity_members AS (
         SELECT a.id AS canonical_id,
            a.user_id,
            unnest(a.member_activity_ids) AS member_id
           FROM fitness.v_activity a
        ), linked_best_source AS (
         SELECT DISTINCT ON (counts.canonical_id, counts.channel) counts.canonical_id,
            counts.channel,
            counts.provider_id
           FROM ( SELECT am.canonical_id,
                    ms.channel,
                    ms.provider_id,
                    count(*) AS sample_count
                   FROM (fitness.metric_stream ms
                     JOIN activity_members am ON ((ms.activity_id = am.member_id)))
                  WHERE (ms.activity_id IS NOT NULL)
                  GROUP BY am.canonical_id, ms.channel, ms.provider_id) counts
          ORDER BY counts.canonical_id, counts.channel, counts.sample_count DESC
        ), linked_sample_bounds AS (
         SELECT am.canonical_id,
            max(ms.recorded_at) AS last_linked_sample_at
           FROM (fitness.metric_stream ms
             JOIN activity_members am ON ((ms.activity_id = am.member_id)))
          WHERE (ms.activity_id IS NOT NULL)
          GROUP BY am.canonical_id
        ), fallback_windows AS (
         SELECT ca.canonical_id,
            ca.user_id,
            ca.started_at,
            COALESCE(ca.ended_at, lsb.last_linked_sample_at) AS fallback_ended_at
           FROM (canonical_activities ca
             LEFT JOIN linked_sample_bounds lsb ON ((lsb.canonical_id = ca.canonical_id)))
        ), ambient_best_source AS (
         SELECT DISTINCT ON (counts.canonical_id, counts.channel) counts.canonical_id,
            counts.channel,
            counts.provider_id
           FROM ( SELECT fw.canonical_id,
                    ms.channel,
                    ms.provider_id,
                    count(*) AS sample_count
                   FROM ((fitness.metric_stream ms
                     JOIN fallback_windows fw ON ((fw.user_id = ms.user_id)))
                     LEFT JOIN linked_best_source lbs ON (((lbs.canonical_id = fw.canonical_id) AND (lbs.channel = ms.channel))))
                  WHERE ((ms.activity_id IS NULL) AND (fw.fallback_ended_at IS NOT NULL) AND (ms.recorded_at >= fw.started_at) AND (ms.recorded_at <= fw.fallback_ended_at) AND (lbs.canonical_id IS NULL))
                  GROUP BY fw.canonical_id, ms.channel, ms.provider_id) counts
          ORDER BY counts.canonical_id, counts.channel, counts.sample_count DESC
        ), linked_samples AS (
         SELECT am.canonical_id AS activity_id,
            am.user_id,
            ms.recorded_at,
            ms.channel,
            max(ms.scalar) AS scalar
           FROM ((fitness.metric_stream ms
             JOIN activity_members am ON ((ms.activity_id = am.member_id)))
             JOIN linked_best_source lbs ON (((am.canonical_id = lbs.canonical_id) AND (ms.channel = lbs.channel) AND (ms.provider_id = lbs.provider_id))))
          WHERE ((ms.activity_id IS NOT NULL) AND (ms.scalar IS NOT NULL))
          GROUP BY am.canonical_id, am.user_id, ms.recorded_at, ms.channel
        ), ambient_samples AS (
         SELECT fw.canonical_id AS activity_id,
            fw.user_id,
            ms.recorded_at,
            ms.channel,
            max(ms.scalar) AS scalar
           FROM ((fitness.metric_stream ms
             JOIN fallback_windows fw ON ((fw.user_id = ms.user_id)))
             JOIN ambient_best_source abs ON (((fw.canonical_id = abs.canonical_id) AND (ms.channel = abs.channel) AND (ms.provider_id = abs.provider_id))))
          WHERE ((ms.activity_id IS NULL) AND (fw.fallback_ended_at IS NOT NULL) AND (ms.recorded_at >= fw.started_at) AND (ms.recorded_at <= fw.fallback_ended_at) AND (ms.scalar IS NOT NULL))
          GROUP BY fw.canonical_id, fw.user_id, ms.recorded_at, ms.channel
        )
 SELECT ls.activity_id,
    ls.user_id,
    ls.recorded_at,
    ls.channel,
    ls.scalar
   FROM linked_samples ls
UNION ALL
 SELECT asmp.activity_id,
    asmp.user_id,
    asmp.recorded_at,
    asmp.channel,
    asmp.scalar
   FROM ambient_samples asmp
  WITH NO DATA;


--
-- Name: activity_summary; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.activity_summary AS
 WITH altitude_deltas AS (
         SELECT deduped_sensor.activity_id,
            deduped_sensor.scalar AS altitude,
            lag(deduped_sensor.scalar) OVER (PARTITION BY deduped_sensor.activity_id ORDER BY deduped_sensor.recorded_at) AS prev_altitude
           FROM fitness.deduped_sensor
          WHERE (deduped_sensor.channel = 'altitude'::text)
        ), elevation_per_activity AS (
         SELECT altitude_deltas.activity_id,
            sum(
                CASE
                    WHEN ((altitude_deltas.altitude - altitude_deltas.prev_altitude) > (0)::double precision) THEN (altitude_deltas.altitude - altitude_deltas.prev_altitude)
                    ELSE (0)::real
                END) AS elevation_gain_m,
            sum(
                CASE
                    WHEN ((altitude_deltas.altitude - altitude_deltas.prev_altitude) < (0)::double precision) THEN abs((altitude_deltas.altitude - altitude_deltas.prev_altitude))
                    ELSE (0)::real
                END) AS elevation_loss_m
           FROM altitude_deltas
          WHERE (altitude_deltas.prev_altitude IS NOT NULL)
          GROUP BY altitude_deltas.activity_id
        ), gps_points AS (
         SELECT lat_s.activity_id,
            lat_s.recorded_at,
            lat_s.scalar AS lat,
            lng_s.scalar AS lng
           FROM (fitness.deduped_sensor lat_s
             JOIN fitness.deduped_sensor lng_s ON (((lat_s.activity_id = lng_s.activity_id) AND (lat_s.recorded_at = lng_s.recorded_at) AND (lng_s.channel = 'lng'::text))))
          WHERE (lat_s.channel = 'lat'::text)
        ), gps_deltas AS (
         SELECT gps_points.activity_id,
            gps_points.lat,
            gps_points.lng,
            lag(gps_points.lat) OVER (PARTITION BY gps_points.activity_id ORDER BY gps_points.recorded_at) AS prev_lat,
            lag(gps_points.lng) OVER (PARTITION BY gps_points.activity_id ORDER BY gps_points.recorded_at) AS prev_lng
           FROM gps_points
        ), distance_per_activity AS (
         SELECT gps_deltas.activity_id,
            (sum((((2 * 6371000))::double precision * asin(sqrt((power(sin((radians(((gps_deltas.lat - gps_deltas.prev_lat))::double precision) / (2)::double precision)), (2)::double precision) + ((cos(radians((gps_deltas.prev_lat)::double precision)) * cos(radians((gps_deltas.lat)::double precision))) * power(sin((radians(((gps_deltas.lng - gps_deltas.prev_lng))::double precision) / (2)::double precision)), (2)::double precision))))))))::real AS total_distance
           FROM gps_deltas
          WHERE (gps_deltas.prev_lat IS NOT NULL)
          GROUP BY gps_deltas.activity_id
        ), channel_aggs AS (
         SELECT deduped_sensor.activity_id,
            deduped_sensor.user_id,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'heart_rate'::text)))::real AS avg_hr,
            (max(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'heart_rate'::text)))::smallint AS max_hr,
            (min(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'heart_rate'::text)))::smallint AS min_hr,
            (avg(deduped_sensor.scalar) FILTER (WHERE ((deduped_sensor.channel = 'power'::text) AND (deduped_sensor.scalar > (0)::double precision))))::real AS avg_power,
            (max(deduped_sensor.scalar) FILTER (WHERE ((deduped_sensor.channel = 'power'::text) AND (deduped_sensor.scalar > (0)::double precision))))::smallint AS max_power,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'speed'::text)))::real AS avg_speed_raw,
            max(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'speed'::text)) AS max_speed_raw,
            (avg(deduped_sensor.scalar) FILTER (WHERE ((deduped_sensor.channel = 'cadence'::text) AND (deduped_sensor.scalar > (0)::double precision))))::real AS avg_cadence,
            max(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'altitude'::text)) AS max_altitude,
            min(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'altitude'::text)) AS min_altitude,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'left_right_balance'::text)))::real AS avg_left_balance,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'left_torque_effectiveness'::text)))::real AS avg_left_torque_eff,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'right_torque_effectiveness'::text)))::real AS avg_right_torque_eff,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'left_pedal_smoothness'::text)))::real AS avg_left_pedal_smooth,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'right_pedal_smoothness'::text)))::real AS avg_right_pedal_smooth,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'stance_time'::text)))::real AS avg_stance_time,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'vertical_oscillation'::text)))::real AS avg_vertical_osc,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'ground_contact_time'::text)))::real AS avg_ground_contact_time,
            (avg(deduped_sensor.scalar) FILTER (WHERE (deduped_sensor.channel = 'stride_length'::text)))::real AS avg_stride_length,
            (count(*))::integer AS sample_count,
            (count(*) FILTER (WHERE (deduped_sensor.channel = 'heart_rate'::text)))::integer AS hr_sample_count,
            (count(*) FILTER (WHERE ((deduped_sensor.channel = 'power'::text) AND (deduped_sensor.scalar > (0)::double precision))))::integer AS power_sample_count,
            min(deduped_sensor.recorded_at) AS first_sample_at,
            max(deduped_sensor.recorded_at) AS last_sample_at
           FROM fitness.deduped_sensor
          GROUP BY deduped_sensor.activity_id, deduped_sensor.user_id
        )
 SELECT ca.activity_id,
    ca.user_id,
    a.activity_type,
    a.started_at,
    a.ended_at,
    a.name,
    ca.avg_hr,
    ca.max_hr,
    ca.min_hr,
    ca.avg_power,
    ca.max_power,
        CASE
            WHEN (a.activity_type = ANY (ARRAY['indoor_cycling'::fitness.activity_type, 'virtual_cycling'::fitness.activity_type])) THEN NULL::real
            ELSE ca.avg_speed_raw
        END AS avg_speed,
        CASE
            WHEN (a.activity_type = ANY (ARRAY['indoor_cycling'::fitness.activity_type, 'virtual_cycling'::fitness.activity_type])) THEN NULL::real
            ELSE ca.max_speed_raw
        END AS max_speed,
    ca.avg_cadence,
        CASE
            WHEN (a.activity_type = ANY (ARRAY['indoor_cycling'::fitness.activity_type, 'virtual_cycling'::fitness.activity_type])) THEN (0)::real
            ELSE COALESCE(d.total_distance, (0)::real)
        END AS total_distance,
    ca.max_altitude,
    ca.min_altitude,
    COALESCE(e.elevation_gain_m, (0)::real) AS elevation_gain_m,
    COALESCE(e.elevation_loss_m, (0)::real) AS elevation_loss_m,
    ca.avg_left_balance,
    ca.avg_left_torque_eff,
    ca.avg_right_torque_eff,
    ca.avg_left_pedal_smooth,
    ca.avg_right_pedal_smooth,
    ca.avg_stance_time,
    ca.avg_vertical_osc,
    ca.avg_ground_contact_time,
    ca.avg_stride_length,
    ca.sample_count,
    ca.hr_sample_count,
    ca.power_sample_count,
    ca.first_sample_at,
    ca.last_sample_at
   FROM (((channel_aggs ca
     JOIN fitness.v_activity a ON ((a.id = ca.activity_id)))
     LEFT JOIN elevation_per_activity e ON ((e.activity_id = ca.activity_id)))
     LEFT JOIN distance_per_activity d ON ((d.activity_id = ca.activity_id)))
  WITH NO DATA;


--
-- Name: allergy_intolerance; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.allergy_intolerance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    external_id text,
    name text NOT NULL,
    type text,
    clinical_status text,
    verification_status text,
    rxnorm_code text,
    onset_date date,
    reactions jsonb,
    source_name text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_account; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.auth_account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    auth_provider text NOT NULL,
    provider_account_id text NOT NULL,
    email text,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    groups text[]
);


--
-- Name: body_measurement; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.body_measurement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    provider_id text NOT NULL,
    external_id text,
    weight_kg real,
    body_fat_pct real,
    muscle_mass_kg real,
    bone_mass_kg real,
    water_pct real,
    bmi real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    systolic_bp integer,
    diastolic_bp integer,
    heart_pulse integer,
    temperature_c real,
    height_cm real,
    waist_circumference_cm real,
    user_id uuid NOT NULL,
    source_name text
);


--
-- Name: body_measurement_value; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.body_measurement_value (
    body_measurement_id uuid NOT NULL,
    measurement_type_id text NOT NULL,
    value real NOT NULL
);


--
-- Name: breathwork_session; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.breathwork_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    technique_id text NOT NULL,
    rounds integer NOT NULL,
    duration_seconds integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cagg_metric_weekly; Type: VIEW; Schema: fitness; Owner: -
--

CREATE VIEW fitness.cagg_metric_weekly AS
 SELECT bucket,
    user_id,
    avg_hr,
    max_hr,
    min_hr,
    avg_power,
    max_power,
    avg_cadence,
    avg_speed,
    max_speed,
    max_altitude,
    min_altitude,
    total_samples,
    hr_samples,
    power_samples,
    cadence_samples,
    activity_count
   FROM _timescaledb_internal._materialized_hypertable_4;


--
-- Name: cagg_sensor_weekly; Type: VIEW; Schema: fitness; Owner: -
--

CREATE VIEW fitness.cagg_sensor_weekly AS
 SELECT bucket,
    user_id,
    channel,
    avg_value,
    max_value,
    min_value,
    sample_count
   FROM _timescaledb_internal._materialized_hypertable_11;


--
-- Name: condition; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.condition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    external_id text,
    name text NOT NULL,
    clinical_status text,
    verification_status text,
    icd10_code text,
    snomed_code text,
    onset_date date,
    abatement_date date,
    recorded_date date,
    source_name text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_metric_type; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.daily_metric_type (
    id text NOT NULL,
    display_name text NOT NULL,
    unit text,
    category text NOT NULL,
    priority_category text DEFAULT 'activity'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_integer boolean DEFAULT false NOT NULL
);


--
-- Name: daily_metric_value; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.daily_metric_value (
    daily_metrics_id uuid NOT NULL,
    metric_type_id text NOT NULL,
    value real NOT NULL
);


--
-- Name: daily_metrics; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.daily_metrics (
    date date NOT NULL,
    provider_id text NOT NULL,
    resting_hr integer,
    hrv real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vo2max real,
    spo2_avg real,
    respiratory_rate_avg real,
    steps integer,
    active_energy_kcal real,
    basal_energy_kcal real,
    distance_km real,
    cycling_distance_km real,
    flights_climbed integer,
    exercise_minutes integer,
    walking_speed real,
    walking_step_length real,
    walking_double_support_pct real,
    walking_asymmetry_pct real,
    walking_steadiness real,
    stand_hours integer,
    skin_temp_c real,
    user_id uuid NOT NULL,
    stress_high_minutes integer,
    recovery_high_minutes integer,
    resilience_level text,
    source_name text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    push_count bigint,
    wheelchair_distance_km real,
    uv_exposure real
);


--
-- Name: dexa_scan; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.dexa_scan (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    external_id text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    scanner_model text,
    total_fat_mass_kg real,
    total_lean_mass_kg real,
    total_bone_mass_kg real,
    total_mass_kg real,
    body_fat_pct real,
    android_gynoid_ratio real,
    visceral_fat_mass_kg real,
    visceral_fat_volume_cm3 real,
    total_bone_mineral_density real,
    bone_density_t_percentile real,
    bone_density_z_percentile real,
    resting_metabolic_rate_kcal real,
    resting_metabolic_rate_raw jsonb,
    percentiles jsonb,
    height_inches real,
    weight_pounds real,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dexa_scan_region; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.dexa_scan_region (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    region text NOT NULL,
    fat_mass_kg real,
    lean_mass_kg real,
    bone_mass_kg real,
    total_mass_kg real,
    tissue_fat_pct real,
    region_fat_pct real,
    bone_mineral_density real,
    bone_area_cm2 real,
    bone_mineral_content_g real,
    z_score_percentile real,
    t_score_percentile real
);


--
-- Name: exercise; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.exercise (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    muscle_group text,
    equipment text,
    movement text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    muscle_groups text[],
    exercise_type text
);


--
-- Name: exercise_alias; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.exercise_alias (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exercise_id uuid NOT NULL,
    provider_id text NOT NULL,
    provider_exercise_id text,
    provider_exercise_name text NOT NULL
);


--
-- Name: food_entry; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.food_entry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    external_id text,
    date date NOT NULL,
    meal fitness.meal,
    food_name text NOT NULL,
    food_description text,
    category fitness.food_category,
    provider_food_id text,
    provider_serving_id text,
    number_of_units real,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    logged_at timestamp with time zone,
    barcode text,
    serving_unit text,
    serving_weight_grams real,
    user_id uuid NOT NULL,
    confirmed boolean DEFAULT true NOT NULL
);


--
-- Name: food_entry_nutrient; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.food_entry_nutrient (
    food_entry_id uuid NOT NULL,
    nutrient_id text NOT NULL,
    amount real NOT NULL
);


--
-- Name: food_entry_nutrition; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.food_entry_nutrition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    food_entry_id uuid NOT NULL,
    calories integer,
    protein_g real,
    carbs_g real,
    fat_g real,
    saturated_fat_g real,
    polyunsaturated_fat_g real,
    monounsaturated_fat_g real,
    trans_fat_g real,
    cholesterol_mg real,
    sodium_mg real,
    potassium_mg real,
    fiber_g real,
    sugar_g real,
    vitamin_a_mcg real,
    vitamin_c_mg real,
    vitamin_d_mcg real,
    vitamin_e_mg real,
    vitamin_k_mcg real,
    vitamin_b1_mg real,
    vitamin_b2_mg real,
    vitamin_b3_mg real,
    vitamin_b5_mg real,
    vitamin_b6_mg real,
    vitamin_b7_mcg real,
    vitamin_b9_mcg real,
    vitamin_b12_mcg real,
    calcium_mg real,
    iron_mg real,
    magnesium_mg real,
    zinc_mg real,
    selenium_mcg real,
    copper_mg real,
    manganese_mg real,
    chromium_mcg real,
    iodine_mcg real,
    omega3_mg real,
    omega6_mg real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: health_event; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.health_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    external_id text,
    type text NOT NULL,
    value real,
    value_text text,
    unit text,
    source_name text,
    start_date timestamp with time zone NOT NULL,
    end_date timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: journal_entry; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.journal_entry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    date date NOT NULL,
    provider_id text NOT NULL,
    answer_text text,
    answer_numeric real,
    impact_score real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    question_slug text NOT NULL
);


--
-- Name: journal_question; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.journal_question (
    slug text NOT NULL,
    display_name text NOT NULL,
    category text NOT NULL,
    data_type text NOT NULL,
    unit text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lab_panel; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.lab_panel (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    external_id text,
    name text NOT NULL,
    loinc_code text,
    status fitness.lab_result_status,
    source_name text,
    recorded_at timestamp with time zone NOT NULL,
    issued_at timestamp with time zone,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lab_result; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.lab_result (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    external_id text,
    test_name text NOT NULL,
    loinc_code text,
    value real,
    value_text text,
    unit text,
    reference_range_low real,
    reference_range_high real,
    reference_range_text text,
    status fitness.lab_result_status,
    source_name text,
    recorded_at timestamp with time zone NOT NULL,
    issued_at timestamp with time zone,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    panel_id uuid
);


--
-- Name: life_events; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.life_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    label text NOT NULL,
    started_at date NOT NULL,
    ended_at date,
    category text,
    ongoing boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: measurement_type; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.measurement_type (
    id text NOT NULL,
    display_name text NOT NULL,
    unit text,
    category text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_integer boolean DEFAULT false NOT NULL
);


--
-- Name: medication; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.medication (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    external_id text,
    name text NOT NULL,
    status text,
    authored_on date,
    start_date date,
    end_date date,
    dosage_text text,
    route text,
    form text,
    rxnorm_code text,
    prescriber_name text,
    reason_text text,
    reason_snomed_code text,
    source_name text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: medication_dose_event; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.medication_dose_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    external_id text,
    medication_name text NOT NULL,
    medication_concept_id text,
    dose_status text NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    source_name text,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: menstrual_period; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.menstrual_period (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nutrient; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.nutrient (
    id text NOT NULL,
    display_name text NOT NULL,
    unit text NOT NULL,
    category text NOT NULL,
    rda real,
    sort_order integer DEFAULT 0 NOT NULL,
    open_food_facts_key text,
    conversion_factor real DEFAULT 1.0 NOT NULL
);


--
-- Name: nutrition_daily; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.nutrition_daily (
    date date NOT NULL,
    provider_id text NOT NULL,
    calories integer,
    protein_g real,
    carbs_g real,
    fat_g real,
    fiber_g real,
    water_ml integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    saturated_fat_g real,
    polyunsaturated_fat_g real,
    monounsaturated_fat_g real,
    trans_fat_g real,
    cholesterol_mg real,
    sodium_mg real,
    potassium_mg real,
    sugar_g real,
    vitamin_a_mcg real,
    vitamin_c_mg real,
    vitamin_d_mcg real,
    vitamin_e_mg real,
    vitamin_k_mcg real,
    vitamin_b1_mg real,
    vitamin_b2_mg real,
    vitamin_b3_mg real,
    vitamin_b5_mg real,
    vitamin_b6_mg real,
    vitamin_b7_mcg real,
    vitamin_b9_mcg real,
    vitamin_b12_mcg real,
    calcium_mg real,
    iron_mg real,
    magnesium_mg real,
    zinc_mg real,
    selenium_mcg real,
    copper_mg real,
    manganese_mg real,
    chromium_mcg real,
    iodine_mcg real,
    omega3_mg real,
    omega6_mg real
);


--
-- Name: nutrition_data; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.nutrition_data (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    calories integer,
    protein_g real,
    carbs_g real,
    fat_g real,
    saturated_fat_g real,
    polyunsaturated_fat_g real,
    monounsaturated_fat_g real,
    trans_fat_g real,
    cholesterol_mg real,
    sodium_mg real,
    potassium_mg real,
    fiber_g real,
    sugar_g real,
    vitamin_a_mcg real,
    vitamin_c_mg real,
    vitamin_d_mcg real,
    vitamin_e_mg real,
    vitamin_k_mcg real,
    vitamin_b1_mg real,
    vitamin_b2_mg real,
    vitamin_b3_mg real,
    vitamin_b5_mg real,
    vitamin_b6_mg real,
    vitamin_b7_mcg real,
    vitamin_b9_mcg real,
    vitamin_b12_mcg real,
    calcium_mg real,
    iron_mg real,
    magnesium_mg real,
    zinc_mg real,
    selenium_mcg real,
    copper_mg real,
    manganese_mg real,
    chromium_mcg real,
    iodine_mcg real,
    omega3_mg real,
    omega6_mg real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_token; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.oauth_token (
    provider_id text NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    expires_at timestamp with time zone NOT NULL,
    scopes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    CONSTRAINT oauth_token_user_id_not_null_chk CHECK ((user_id IS NOT NULL))
);


--
-- Name: provider; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.provider (
    id text NOT NULL,
    name text NOT NULL,
    api_base_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: sleep_session; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.sleep_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    external_id text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    duration_minutes integer,
    deep_minutes integer,
    rem_minutes integer,
    light_minutes integer,
    awake_minutes integer,
    efficiency_pct real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    source_name text,
    sleep_type text,
    sleep_need_baseline_minutes integer,
    sleep_need_from_debt_minutes integer,
    sleep_need_from_strain_minutes integer,
    sleep_need_from_nap_minutes integer
);


--
-- Name: provider_stats; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.provider_stats AS
 WITH providers AS (
         SELECT DISTINCT oauth_token.user_id,
            oauth_token.provider_id
           FROM fitness.oauth_token
        UNION
         SELECT DISTINCT activity.user_id,
            activity.provider_id
           FROM fitness.activity
        UNION
         SELECT DISTINCT daily_metrics.user_id,
            daily_metrics.provider_id
           FROM fitness.daily_metrics
        UNION
         SELECT DISTINCT sleep_session.user_id,
            sleep_session.provider_id
           FROM fitness.sleep_session
        UNION
         SELECT DISTINCT body_measurement.user_id,
            body_measurement.provider_id
           FROM fitness.body_measurement
        UNION
         SELECT DISTINCT food_entry.user_id,
            food_entry.provider_id
           FROM fitness.food_entry
        UNION
         SELECT DISTINCT health_event.user_id,
            health_event.provider_id
           FROM fitness.health_event
        UNION
         SELECT DISTINCT metric_stream.user_id,
            metric_stream.provider_id
           FROM fitness.metric_stream
        UNION
         SELECT DISTINCT nutrition_daily.user_id,
            nutrition_daily.provider_id
           FROM fitness.nutrition_daily
        UNION
         SELECT DISTINCT lab_panel.user_id,
            lab_panel.provider_id
           FROM fitness.lab_panel
        UNION
         SELECT DISTINCT lab_result.user_id,
            lab_result.provider_id
           FROM fitness.lab_result
        UNION
         SELECT DISTINCT journal_entry.user_id,
            journal_entry.provider_id
           FROM fitness.journal_entry
        )
 SELECT p.user_id,
    p.provider_id,
    COALESCE(a.cnt, (0)::bigint) AS activities,
    COALESCE(dm.cnt, (0)::bigint) AS daily_metrics,
    COALESCE(ss.cnt, (0)::bigint) AS sleep_sessions,
    COALESCE(bm.cnt, (0)::bigint) AS body_measurements,
    COALESCE(fe.cnt, (0)::bigint) AS food_entries,
    COALESCE(he.cnt, (0)::bigint) AS health_events,
    COALESCE(ms.cnt, (0)::bigint) AS metric_stream,
    COALESCE(nd.cnt, (0)::bigint) AS nutrition_daily,
    COALESCE(lp.cnt, (0)::bigint) AS lab_panels,
    COALESCE(lr.cnt, (0)::bigint) AS lab_results,
    COALESCE(je.cnt, (0)::bigint) AS journal_entries
   FROM (((((((((((providers p
     LEFT JOIN ( SELECT activity.user_id,
            activity.provider_id,
            count(*) AS cnt
           FROM fitness.activity
          GROUP BY activity.user_id, activity.provider_id) a ON (((a.user_id = p.user_id) AND (a.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT daily_metrics.user_id,
            daily_metrics.provider_id,
            count(*) AS cnt
           FROM fitness.daily_metrics
          GROUP BY daily_metrics.user_id, daily_metrics.provider_id) dm ON (((dm.user_id = p.user_id) AND (dm.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT sleep_session.user_id,
            sleep_session.provider_id,
            count(*) AS cnt
           FROM fitness.sleep_session
          GROUP BY sleep_session.user_id, sleep_session.provider_id) ss ON (((ss.user_id = p.user_id) AND (ss.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT body_measurement.user_id,
            body_measurement.provider_id,
            count(*) AS cnt
           FROM fitness.body_measurement
          GROUP BY body_measurement.user_id, body_measurement.provider_id) bm ON (((bm.user_id = p.user_id) AND (bm.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT food_entry.user_id,
            food_entry.provider_id,
            count(*) AS cnt
           FROM fitness.food_entry
          WHERE (food_entry.confirmed = true)
          GROUP BY food_entry.user_id, food_entry.provider_id) fe ON (((fe.user_id = p.user_id) AND (fe.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT health_event.user_id,
            health_event.provider_id,
            count(*) AS cnt
           FROM fitness.health_event
          GROUP BY health_event.user_id, health_event.provider_id) he ON (((he.user_id = p.user_id) AND (he.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT metric_stream.user_id,
            metric_stream.provider_id,
            count(*) AS cnt
           FROM fitness.metric_stream
          GROUP BY metric_stream.user_id, metric_stream.provider_id) ms ON (((ms.user_id = p.user_id) AND (ms.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT nutrition_daily.user_id,
            nutrition_daily.provider_id,
            count(*) AS cnt
           FROM fitness.nutrition_daily
          GROUP BY nutrition_daily.user_id, nutrition_daily.provider_id) nd ON (((nd.user_id = p.user_id) AND (nd.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT lab_panel.user_id,
            lab_panel.provider_id,
            count(*) AS cnt
           FROM fitness.lab_panel
          GROUP BY lab_panel.user_id, lab_panel.provider_id) lp ON (((lp.user_id = p.user_id) AND (lp.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT lab_result.user_id,
            lab_result.provider_id,
            count(*) AS cnt
           FROM fitness.lab_result
          GROUP BY lab_result.user_id, lab_result.provider_id) lr ON (((lr.user_id = p.user_id) AND (lr.provider_id = p.provider_id))))
     LEFT JOIN ( SELECT journal_entry.user_id,
            journal_entry.provider_id,
            count(*) AS cnt
           FROM fitness.journal_entry
          GROUP BY journal_entry.user_id, journal_entry.provider_id) je ON (((je.user_id = p.user_id) AND (je.provider_id = p.provider_id))))
  WITH NO DATA;


--
-- Name: session; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.session (
    id text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shared_report; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.shared_report (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    share_token text NOT NULL,
    report_type text NOT NULL,
    report_data jsonb NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_installation; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.slack_installation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id text NOT NULL,
    team_name text,
    bot_token text NOT NULL,
    bot_id text,
    bot_user_id text,
    app_id text,
    installer_slack_user_id text,
    raw_installation jsonb NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sleep_stage; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.sleep_stage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    stage fitness.sleep_stage_name NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    source_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sport_settings; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.sport_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    sport text NOT NULL,
    ftp smallint,
    threshold_hr smallint,
    threshold_pace_per_km real,
    power_zone_pcts jsonb,
    hr_zone_pcts jsonb,
    pace_zone_pcts jsonb,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: strength_set; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.strength_set (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workout_id uuid NOT NULL,
    exercise_id uuid NOT NULL,
    exercise_index integer NOT NULL,
    set_index integer NOT NULL,
    set_type fitness.set_type DEFAULT 'working'::fitness.set_type,
    weight_kg real,
    reps integer,
    distance_meters real,
    duration_seconds integer,
    rpe real,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    strap_location text,
    strap_location_laterality text
);


--
-- Name: strength_workout; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.strength_workout (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    external_id text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    name text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    raw_msk_strain_score real,
    scaled_msk_strain_score real,
    cardio_strain_score real,
    cardio_strain_contribution_percent real,
    msk_strain_contribution_percent real
);


--
-- Name: supplement; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.supplement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    amount real,
    unit text,
    form text,
    description text,
    meal fitness.meal,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supplement_nutrient; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.supplement_nutrient (
    supplement_id uuid NOT NULL,
    nutrient_id text NOT NULL,
    amount real NOT NULL
);


--
-- Name: supplement_nutrition; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.supplement_nutrition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    supplement_id uuid NOT NULL,
    calories integer,
    protein_g real,
    carbs_g real,
    fat_g real,
    saturated_fat_g real,
    polyunsaturated_fat_g real,
    monounsaturated_fat_g real,
    trans_fat_g real,
    cholesterol_mg real,
    sodium_mg real,
    potassium_mg real,
    fiber_g real,
    sugar_g real,
    vitamin_a_mcg real,
    vitamin_c_mg real,
    vitamin_d_mcg real,
    vitamin_e_mg real,
    vitamin_k_mcg real,
    vitamin_b1_mg real,
    vitamin_b2_mg real,
    vitamin_b3_mg real,
    vitamin_b5_mg real,
    vitamin_b6_mg real,
    vitamin_b7_mcg real,
    vitamin_b9_mcg real,
    vitamin_b12_mcg real,
    calcium_mg real,
    iron_mg real,
    magnesium_mg real,
    zinc_mg real,
    selenium_mcg real,
    copper_mg real,
    manganese_mg real,
    chromium_mcg real,
    iodine_mcg real,
    omega3_mg real,
    omega6_mg real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sync_log; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.sync_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text NOT NULL,
    data_type text NOT NULL,
    status text NOT NULL,
    record_count integer DEFAULT 0,
    error_message text,
    duration_ms integer,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: training_export_watermark; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.training_export_watermark (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_name text NOT NULL,
    last_exported_at timestamp with time zone NOT NULL,
    row_count bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_profile; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.user_profile (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text,
    max_hr smallint,
    resting_hr smallint,
    ftp smallint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    birth_date date,
    is_admin boolean DEFAULT false NOT NULL
);


--
-- Name: user_settings; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.user_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: v_body_measurement; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.v_body_measurement AS
 WITH RECURSIVE ranked AS (
         SELECT b_1.id,
            b_1.recorded_at,
            b_1.provider_id,
            b_1.external_id,
            b_1.weight_kg,
            b_1.body_fat_pct,
            b_1.muscle_mass_kg,
            b_1.bone_mass_kg,
            b_1.water_pct,
            b_1.bmi,
            b_1.created_at,
            b_1.systolic_bp,
            b_1.diastolic_bp,
            b_1.heart_pulse,
            b_1.temperature_c,
            b_1.height_cm,
            b_1.waist_circumference_cm,
            b_1.user_id,
            b_1.source_name,
            COALESCE(dp.body_priority, pp.body_priority, dp.priority, pp.priority, 100) AS prio
           FROM ((fitness.body_measurement b_1
             LEFT JOIN fitness.provider_priority pp ON ((pp.provider_id = b_1.provider_id)))
             LEFT JOIN LATERAL ( SELECT dp2.body_priority,
                    dp2.priority
                   FROM fitness.device_priority dp2
                  WHERE ((dp2.provider_id = b_1.provider_id) AND (b_1.source_name ~~ dp2.source_name_pattern))
                  ORDER BY (length(dp2.source_name_pattern)) DESC
                 LIMIT 1) dp ON (true))
        ), pairs AS (
         SELECT r1.id AS id1,
            r2.id AS id2
           FROM (ranked r1
             JOIN ranked r2 ON (((r1.id < r2.id) AND (r1.user_id = r2.user_id) AND (abs(EXTRACT(epoch FROM (r1.recorded_at - r2.recorded_at))) < (300)::numeric))))
        ), edges AS (
         SELECT pairs.id1 AS a,
            pairs.id2 AS b
           FROM pairs
        UNION ALL
         SELECT pairs.id2 AS a,
            pairs.id1 AS b
           FROM pairs
        ), clusters(measurement_id, group_id) AS (
         SELECT ranked.id,
            (ranked.id)::text AS id
           FROM ranked
        UNION
         SELECT e.b,
            c.group_id
           FROM (edges e
             JOIN clusters c ON ((c.measurement_id = e.a)))
        ), final_groups AS (
         SELECT clusters.measurement_id,
            min(clusters.group_id) AS group_id
           FROM clusters
          GROUP BY clusters.measurement_id
        ), best AS (
         SELECT DISTINCT ON (fg.group_id) fg.group_id,
            r.id AS canonical_id,
            r.provider_id,
            r.user_id,
            r.recorded_at,
            r.prio
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          ORDER BY fg.group_id, r.prio, r.id
        )
 SELECT canonical_id AS id,
    provider_id,
    user_id,
    recorded_at,
    ( SELECT r.weight_kg
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.weight_kg IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS weight_kg,
    ( SELECT r.body_fat_pct
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.body_fat_pct IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS body_fat_pct,
    ( SELECT r.muscle_mass_kg
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.muscle_mass_kg IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS muscle_mass_kg,
    ( SELECT r.bmi
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.bmi IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS bmi,
    ( SELECT r.systolic_bp
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.systolic_bp IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS systolic_bp,
    ( SELECT r.diastolic_bp
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.diastolic_bp IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS diastolic_bp,
    ( SELECT r.temperature_c
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.temperature_c IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS temperature_c,
    ( SELECT r.height_cm
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE ((fg.group_id = b.group_id) AND (r.height_cm IS NOT NULL))
          ORDER BY r.prio
         LIMIT 1) AS height_cm,
    ( SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id) AS array_agg
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.measurement_id)))
          WHERE (fg.group_id = b.group_id)) AS source_providers
   FROM best b
  ORDER BY recorded_at DESC
  WITH NO DATA;


--
-- Name: v_daily_metrics; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.v_daily_metrics AS
 WITH ranked AS (
         SELECT d.date,
            d.provider_id,
            d.resting_hr,
            d.hrv,
            d.created_at,
            d.vo2max,
            d.spo2_avg,
            d.respiratory_rate_avg,
            d.steps,
            d.active_energy_kcal,
            d.basal_energy_kcal,
            d.distance_km,
            d.cycling_distance_km,
            d.flights_climbed,
            d.exercise_minutes,
            d.walking_speed,
            d.walking_step_length,
            d.walking_double_support_pct,
            d.walking_asymmetry_pct,
            d.walking_steadiness,
            d.stand_hours,
            d.skin_temp_c,
            d.user_id,
            d.stress_high_minutes,
            d.recovery_high_minutes,
            d.resilience_level,
            d.source_name,
            d.id,
            d.push_count,
            d.wheelchair_distance_km,
            d.uv_exposure,
            COALESCE(dp.recovery_priority, pp.recovery_priority, dp.priority, pp.priority, 100) AS recovery_prio,
            COALESCE(dp.daily_activity_priority, pp.daily_activity_priority, dp.priority, pp.priority, 100) AS activity_prio
           FROM ((fitness.daily_metrics d
             LEFT JOIN fitness.provider_priority pp ON ((pp.provider_id = d.provider_id)))
             LEFT JOIN LATERAL ( SELECT dp2.recovery_priority,
                    dp2.daily_activity_priority,
                    dp2.priority
                   FROM fitness.device_priority dp2
                  WHERE ((dp2.provider_id = d.provider_id) AND (d.source_name ~~ dp2.source_name_pattern))
                  ORDER BY (length(dp2.source_name_pattern)) DESC
                 LIMIT 1) dp ON (true))
        )
 SELECT date,
    user_id,
    ( SELECT r.resting_hr
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.resting_hr IS NOT NULL))
          ORDER BY r.recovery_prio
         LIMIT 1) AS resting_hr,
    ( SELECT r.hrv
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.hrv IS NOT NULL))
          ORDER BY r.recovery_prio
         LIMIT 1) AS hrv,
    ( SELECT r.vo2max
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.vo2max IS NOT NULL))
          ORDER BY r.recovery_prio
         LIMIT 1) AS vo2max,
    ( SELECT r.spo2_avg
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.spo2_avg IS NOT NULL))
          ORDER BY r.recovery_prio
         LIMIT 1) AS spo2_avg,
    ( SELECT r.respiratory_rate_avg
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.respiratory_rate_avg IS NOT NULL))
          ORDER BY r.recovery_prio
         LIMIT 1) AS respiratory_rate_avg,
    ( SELECT r.skin_temp_c
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.skin_temp_c IS NOT NULL))
          ORDER BY r.recovery_prio
         LIMIT 1) AS skin_temp_c,
    ( SELECT r.steps
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.steps IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS steps,
    ( SELECT r.active_energy_kcal
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.active_energy_kcal IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS active_energy_kcal,
    ( SELECT r.basal_energy_kcal
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.basal_energy_kcal IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS basal_energy_kcal,
    ( SELECT r.distance_km
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.distance_km IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS distance_km,
    ( SELECT r.flights_climbed
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.flights_climbed IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS flights_climbed,
    ( SELECT r.exercise_minutes
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.exercise_minutes IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS exercise_minutes,
    ( SELECT r.stand_hours
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.stand_hours IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS stand_hours,
    ( SELECT r.walking_speed
           FROM ranked r
          WHERE ((r.date = dm.date) AND (r.user_id = dm.user_id) AND (r.walking_speed IS NOT NULL))
          ORDER BY r.activity_prio
         LIMIT 1) AS walking_speed,
    array_agg(DISTINCT provider_id ORDER BY provider_id) AS source_providers
   FROM fitness.daily_metrics dm
  GROUP BY date, user_id
  WITH NO DATA;


--
-- Name: v_food_entry_with_nutrition; Type: VIEW; Schema: fitness; Owner: -
--

CREATE VIEW fitness.v_food_entry_with_nutrition AS
 SELECT fe.id,
    fe.provider_id,
    fe.user_id,
    fe.external_id,
    fe.date,
    fe.meal,
    fe.food_name,
    fe.food_description,
    fe.category,
    fe.provider_food_id,
    fe.provider_serving_id,
    fe.number_of_units,
    fe.logged_at,
    fe.barcode,
    fe.serving_unit,
    fe.serving_weight_grams,
    fen.id AS nutrition_data_id,
    fen.calories,
    fen.protein_g,
    fen.carbs_g,
    fen.fat_g,
    fen.saturated_fat_g,
    fen.polyunsaturated_fat_g,
    fen.monounsaturated_fat_g,
    fen.trans_fat_g,
    fen.cholesterol_mg,
    fen.sodium_mg,
    fen.potassium_mg,
    fen.fiber_g,
    fen.sugar_g,
    fen.vitamin_a_mcg,
    fen.vitamin_c_mg,
    fen.vitamin_d_mcg,
    fen.vitamin_e_mg,
    fen.vitamin_k_mcg,
    fen.vitamin_b1_mg,
    fen.vitamin_b2_mg,
    fen.vitamin_b3_mg,
    fen.vitamin_b5_mg,
    fen.vitamin_b6_mg,
    fen.vitamin_b7_mcg,
    fen.vitamin_b9_mcg,
    fen.vitamin_b12_mcg,
    fen.calcium_mg,
    fen.iron_mg,
    fen.magnesium_mg,
    fen.zinc_mg,
    fen.selenium_mcg,
    fen.copper_mg,
    fen.manganese_mg,
    fen.chromium_mcg,
    fen.iodine_mcg,
    fen.omega3_mg,
    fen.omega6_mg,
    fe.raw,
    fe.confirmed,
    fe.created_at
   FROM (fitness.food_entry fe
     LEFT JOIN fitness.food_entry_nutrition fen ON ((fen.food_entry_id = fe.id)));


--
-- Name: v_metric_stream; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.v_metric_stream AS
 WITH best_source AS (
         SELECT DISTINCT ON (counts.activity_id, counts.channel) counts.activity_id,
            counts.channel,
            counts.provider_id
           FROM ( SELECT metric_stream.activity_id,
                    metric_stream.channel,
                    metric_stream.provider_id,
                    count(*) AS sample_count
                   FROM fitness.metric_stream
                  WHERE ((metric_stream.activity_id IS NOT NULL) AND (metric_stream.scalar IS NOT NULL))
                  GROUP BY metric_stream.activity_id, metric_stream.channel, metric_stream.provider_id) counts
          ORDER BY counts.activity_id, counts.channel, counts.sample_count DESC
        ), deduped AS (
         SELECT ss.recorded_at,
            ss.user_id,
            ss.activity_id,
            ss.provider_id,
            ss.device_id,
            ss.channel,
            ss.scalar
           FROM (fitness.metric_stream ss
             JOIN best_source bs ON (((ss.activity_id = bs.activity_id) AND (ss.channel = bs.channel) AND (ss.provider_id = bs.provider_id))))
          WHERE ((ss.activity_id IS NOT NULL) AND (ss.scalar IS NOT NULL))
        )
 SELECT recorded_at,
    user_id,
    activity_id,
    (max(scalar) FILTER (WHERE (channel = 'heart_rate'::text)))::smallint AS heart_rate,
    (max(scalar) FILTER (WHERE (channel = 'power'::text)))::smallint AS power,
    (max(scalar) FILTER (WHERE (channel = 'cadence'::text)))::smallint AS cadence,
    max(scalar) FILTER (WHERE (channel = 'speed'::text)) AS speed,
    max(scalar) FILTER (WHERE (channel = 'lat'::text)) AS lat,
    max(scalar) FILTER (WHERE (channel = 'lng'::text)) AS lng,
    max(scalar) FILTER (WHERE (channel = 'altitude'::text)) AS altitude,
    max(scalar) FILTER (WHERE (channel = 'temperature'::text)) AS temperature,
    max(scalar) FILTER (WHERE (channel = 'grade'::text)) AS grade,
    max(scalar) FILTER (WHERE (channel = 'vertical_speed'::text)) AS vertical_speed,
    max(scalar) FILTER (WHERE (channel = 'spo2'::text)) AS spo2,
    max(scalar) FILTER (WHERE (channel = 'respiratory_rate'::text)) AS respiratory_rate,
    (max(scalar) FILTER (WHERE (channel = 'gps_accuracy'::text)))::smallint AS gps_accuracy,
    (max(scalar) FILTER (WHERE (channel = 'accumulated_power'::text)))::integer AS accumulated_power,
    (max(scalar) FILTER (WHERE (channel = 'stress'::text)))::smallint AS stress,
    max(scalar) FILTER (WHERE (channel = 'left_right_balance'::text)) AS left_right_balance,
    max(scalar) FILTER (WHERE (channel = 'vertical_oscillation'::text)) AS vertical_oscillation,
    max(scalar) FILTER (WHERE (channel = 'stance_time'::text)) AS stance_time,
    max(scalar) FILTER (WHERE (channel = 'stance_time_percent'::text)) AS stance_time_percent,
    max(scalar) FILTER (WHERE (channel = 'step_length'::text)) AS step_length,
    max(scalar) FILTER (WHERE (channel = 'vertical_ratio'::text)) AS vertical_ratio,
    max(scalar) FILTER (WHERE (channel = 'stance_time_balance'::text)) AS stance_time_balance,
    max(scalar) FILTER (WHERE (channel = 'ground_contact_time'::text)) AS ground_contact_time,
    max(scalar) FILTER (WHERE (channel = 'stride_length'::text)) AS stride_length,
    max(scalar) FILTER (WHERE (channel = 'form_power'::text)) AS form_power,
    max(scalar) FILTER (WHERE (channel = 'leg_spring_stiff'::text)) AS leg_spring_stiff,
    max(scalar) FILTER (WHERE (channel = 'air_power'::text)) AS air_power,
    max(scalar) FILTER (WHERE (channel = 'left_torque_effectiveness'::text)) AS left_torque_effectiveness,
    max(scalar) FILTER (WHERE (channel = 'right_torque_effectiveness'::text)) AS right_torque_effectiveness,
    max(scalar) FILTER (WHERE (channel = 'left_pedal_smoothness'::text)) AS left_pedal_smoothness,
    max(scalar) FILTER (WHERE (channel = 'right_pedal_smoothness'::text)) AS right_pedal_smoothness,
    max(scalar) FILTER (WHERE (channel = 'combined_pedal_smoothness'::text)) AS combined_pedal_smoothness,
    max(scalar) FILTER (WHERE (channel = 'blood_glucose'::text)) AS blood_glucose,
    max(scalar) FILTER (WHERE (channel = 'audio_exposure'::text)) AS audio_exposure,
    max(scalar) FILTER (WHERE (channel = 'skin_temperature'::text)) AS skin_temperature,
    max(scalar) FILTER (WHERE (channel = 'electrodermal_activity'::text)) AS electrodermal_activity,
    max(device_id) AS source_name
   FROM deduped
  GROUP BY recorded_at, user_id, activity_id
  WITH NO DATA;


--
-- Name: v_sleep; Type: MATERIALIZED VIEW; Schema: fitness; Owner: -
--

CREATE MATERIALIZED VIEW fitness.v_sleep AS
 WITH RECURSIVE ranked AS (
         SELECT s.id,
            s.provider_id,
            s.external_id,
            s.started_at,
            s.ended_at,
            s.duration_minutes,
            s.deep_minutes,
            s.rem_minutes,
            s.light_minutes,
            s.awake_minutes,
            s.efficiency_pct,
            s.created_at,
            s.user_id,
            s.source_name,
            s.sleep_type,
            s.sleep_need_baseline_minutes,
            s.sleep_need_from_debt_minutes,
            s.sleep_need_from_strain_minutes,
            s.sleep_need_from_nap_minutes,
            COALESCE(dp.sleep_priority, pp.sleep_priority, dp.priority, pp.priority, 100) AS prio,
                CASE
                    WHEN (s.sleep_type = ANY (ARRAY['nap'::text, 'late_nap'::text, 'rest'::text])) THEN true
                    WHEN (s.sleep_type = ANY (ARRAY['sleep'::text, 'long_sleep'::text, 'main'::text])) THEN false
                    WHEN (s.sleep_type = 'not_main'::text) THEN COALESCE((s.duration_minutes < 120), true)
                    WHEN (s.duration_minutes IS NOT NULL) THEN (s.duration_minutes < 120)
                    ELSE false
                END AS is_nap
           FROM ((fitness.sleep_session s
             LEFT JOIN fitness.provider_priority pp ON ((pp.provider_id = s.provider_id)))
             LEFT JOIN LATERAL ( SELECT dp2.sleep_priority,
                    dp2.priority
                   FROM fitness.device_priority dp2
                  WHERE ((dp2.provider_id = s.provider_id) AND (s.source_name ~~ dp2.source_name_pattern))
                  ORDER BY (length(dp2.source_name_pattern)) DESC
                 LIMIT 1) dp ON (true))
        ), pairs AS (
         SELECT r1.id AS id1,
            r2.id AS id2
           FROM (ranked r1
             JOIN ranked r2 ON (((r1.id < r2.id) AND (r1.user_id = r2.user_id) AND (r1.is_nap = r2.is_nap) AND ((EXTRACT(epoch FROM (LEAST(COALESCE(r1.ended_at, (r1.started_at + '08:00:00'::interval)), COALESCE(r2.ended_at, (r2.started_at + '08:00:00'::interval))) - GREATEST(r1.started_at, r2.started_at))) / NULLIF(EXTRACT(epoch FROM (GREATEST(COALESCE(r1.ended_at, (r1.started_at + '08:00:00'::interval)), COALESCE(r2.ended_at, (r2.started_at + '08:00:00'::interval))) - LEAST(r1.started_at, r2.started_at))), (0)::numeric)) > 0.8))))
        ), edges AS (
         SELECT pairs.id1 AS a,
            pairs.id2 AS b
           FROM pairs
        UNION ALL
         SELECT pairs.id2 AS a,
            pairs.id1 AS b
           FROM pairs
        ), clusters(sleep_id, group_id) AS (
         SELECT ranked.id,
            (ranked.id)::text AS id
           FROM ranked
        UNION
         SELECT e.b,
            c.group_id
           FROM (edges e
             JOIN clusters c ON ((c.sleep_id = e.a)))
        ), final_groups AS (
         SELECT clusters.sleep_id,
            min(clusters.group_id) AS group_id
           FROM clusters
          GROUP BY clusters.sleep_id
        ), best AS (
         SELECT DISTINCT ON (fg.group_id) fg.group_id,
            r.id,
            r.provider_id,
            r.external_id,
            r.started_at,
            r.ended_at,
            r.duration_minutes,
            r.deep_minutes,
            r.rem_minutes,
            r.light_minutes,
            r.awake_minutes,
            r.efficiency_pct,
            r.created_at,
            r.user_id,
            r.source_name,
            r.sleep_type,
            r.sleep_need_baseline_minutes,
            r.sleep_need_from_debt_minutes,
            r.sleep_need_from_strain_minutes,
            r.sleep_need_from_nap_minutes,
            r.prio,
            r.is_nap
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.sleep_id)))
          ORDER BY fg.group_id, r.prio, r.id
        )
 SELECT id,
    provider_id,
    user_id,
    started_at,
    ended_at,
    duration_minutes,
    deep_minutes,
    rem_minutes,
    light_minutes,
    awake_minutes,
    COALESCE(efficiency_pct, (
        CASE
            WHEN ((provider_id = 'apple_health'::text) AND (duration_minutes > 0) AND ((deep_minutes IS NOT NULL) OR (rem_minutes IS NOT NULL) OR (light_minutes IS NOT NULL))) THEN round((((((COALESCE(deep_minutes, 0) + COALESCE(rem_minutes, 0)) + COALESCE(light_minutes, 0)))::numeric / (duration_minutes)::numeric) * (100)::numeric), 1)
            WHEN ((provider_id = ANY (ARRAY['eight-sleep'::text, 'polar'::text])) AND (duration_minutes > 0) AND (awake_minutes IS NOT NULL)) THEN round((((duration_minutes)::numeric / ((duration_minutes + awake_minutes))::numeric) * (100)::numeric), 1)
            ELSE NULL::numeric
        END)::real) AS efficiency_pct,
    sleep_type,
    is_nap,
    source_name,
    ( SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id) AS array_agg
           FROM (final_groups fg
             JOIN ranked r ON ((r.id = fg.sleep_id)))
          WHERE (fg.group_id = b.group_id)) AS source_providers
   FROM best b
  ORDER BY started_at DESC
  WITH NO DATA;


--
-- Name: v_supplement_with_nutrition; Type: VIEW; Schema: fitness; Owner: -
--

CREATE VIEW fitness.v_supplement_with_nutrition AS
 SELECT s.id,
    s.user_id,
    s.name,
    s.amount,
    s.unit,
    s.form,
    s.description,
    s.meal,
    s.sort_order,
    sn.id AS nutrition_data_id,
    sn.calories,
    sn.protein_g,
    sn.carbs_g,
    sn.fat_g,
    sn.saturated_fat_g,
    sn.polyunsaturated_fat_g,
    sn.monounsaturated_fat_g,
    sn.trans_fat_g,
    sn.cholesterol_mg,
    sn.sodium_mg,
    sn.potassium_mg,
    sn.fiber_g,
    sn.sugar_g,
    sn.vitamin_a_mcg,
    sn.vitamin_c_mg,
    sn.vitamin_d_mcg,
    sn.vitamin_e_mg,
    sn.vitamin_k_mcg,
    sn.vitamin_b1_mg,
    sn.vitamin_b2_mg,
    sn.vitamin_b3_mg,
    sn.vitamin_b5_mg,
    sn.vitamin_b6_mg,
    sn.vitamin_b7_mcg,
    sn.vitamin_b9_mcg,
    sn.vitamin_b12_mcg,
    sn.calcium_mg,
    sn.iron_mg,
    sn.magnesium_mg,
    sn.zinc_mg,
    sn.selenium_mcg,
    sn.copper_mg,
    sn.manganese_mg,
    sn.chromium_mcg,
    sn.iodine_mcg,
    sn.omega3_mg,
    sn.omega6_mg,
    s.created_at,
    s.updated_at
   FROM (fitness.supplement s
     LEFT JOIN fitness.supplement_nutrition sn ON ((sn.supplement_id = s.id)));


--
-- Name: webhook_subscription; Type: TABLE; Schema: fitness; Owner: -
--

CREATE TABLE fitness.webhook_subscription (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id text,
    provider_name text NOT NULL,
    subscription_external_id text,
    verify_token text NOT NULL,
    signing_secret text,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: activity_interval activity_interval_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.activity_interval
    ADD CONSTRAINT activity_interval_pkey PRIMARY KEY (id);


--
-- Name: allergy_intolerance allergy_intolerance_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.allergy_intolerance
    ADD CONSTRAINT allergy_intolerance_pkey PRIMARY KEY (id);


--
-- Name: auth_account auth_account_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);


--
-- Name: body_measurement body_measurement_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.body_measurement
    ADD CONSTRAINT body_measurement_pkey PRIMARY KEY (id);


--
-- Name: body_measurement_value body_measurement_value_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.body_measurement_value
    ADD CONSTRAINT body_measurement_value_pkey PRIMARY KEY (body_measurement_id, measurement_type_id);


--
-- Name: breathwork_session breathwork_session_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.breathwork_session
    ADD CONSTRAINT breathwork_session_pkey PRIMARY KEY (id);


--
-- Name: activity cardio_activity_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.activity
    ADD CONSTRAINT cardio_activity_pkey PRIMARY KEY (id);


--
-- Name: condition condition_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.condition
    ADD CONSTRAINT condition_pkey PRIMARY KEY (id);


--
-- Name: daily_metric_type daily_metric_type_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.daily_metric_type
    ADD CONSTRAINT daily_metric_type_pkey PRIMARY KEY (id);


--
-- Name: daily_metric_value daily_metric_value_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.daily_metric_value
    ADD CONSTRAINT daily_metric_value_pkey PRIMARY KEY (daily_metrics_id, metric_type_id);


--
-- Name: daily_metrics daily_metrics_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.daily_metrics
    ADD CONSTRAINT daily_metrics_pkey PRIMARY KEY (id);


--
-- Name: device_priority device_priority_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.device_priority
    ADD CONSTRAINT device_priority_pkey PRIMARY KEY (provider_id, source_name_pattern);


--
-- Name: dexa_scan dexa_scan_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.dexa_scan
    ADD CONSTRAINT dexa_scan_pkey PRIMARY KEY (id);


--
-- Name: dexa_scan_region dexa_scan_region_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.dexa_scan_region
    ADD CONSTRAINT dexa_scan_region_pkey PRIMARY KEY (id);


--
-- Name: exercise_alias exercise_alias_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.exercise_alias
    ADD CONSTRAINT exercise_alias_pkey PRIMARY KEY (id);


--
-- Name: exercise exercise_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.exercise
    ADD CONSTRAINT exercise_pkey PRIMARY KEY (id);


--
-- Name: food_entry_nutrient food_entry_nutrient_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry_nutrient
    ADD CONSTRAINT food_entry_nutrient_pkey PRIMARY KEY (food_entry_id, nutrient_id);


--
-- Name: food_entry_nutrition food_entry_nutrition_food_entry_id_unique; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry_nutrition
    ADD CONSTRAINT food_entry_nutrition_food_entry_id_unique UNIQUE (food_entry_id);


--
-- Name: food_entry_nutrition food_entry_nutrition_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry_nutrition
    ADD CONSTRAINT food_entry_nutrition_pkey PRIMARY KEY (id);


--
-- Name: food_entry food_entry_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry
    ADD CONSTRAINT food_entry_pkey PRIMARY KEY (id);


--
-- Name: health_event health_event_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.health_event
    ADD CONSTRAINT health_event_pkey PRIMARY KEY (id);


--
-- Name: journal_entry journal_entry_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.journal_entry
    ADD CONSTRAINT journal_entry_pkey PRIMARY KEY (id);


--
-- Name: journal_question journal_question_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.journal_question
    ADD CONSTRAINT journal_question_pkey PRIMARY KEY (slug);


--
-- Name: lab_panel lab_panel_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.lab_panel
    ADD CONSTRAINT lab_panel_pkey PRIMARY KEY (id);


--
-- Name: lab_result lab_result_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.lab_result
    ADD CONSTRAINT lab_result_pkey PRIMARY KEY (id);


--
-- Name: life_events life_events_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.life_events
    ADD CONSTRAINT life_events_pkey PRIMARY KEY (id);


--
-- Name: measurement_type measurement_type_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.measurement_type
    ADD CONSTRAINT measurement_type_pkey PRIMARY KEY (id);


--
-- Name: medication_dose_event medication_dose_event_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.medication_dose_event
    ADD CONSTRAINT medication_dose_event_pkey PRIMARY KEY (id);


--
-- Name: medication medication_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.medication
    ADD CONSTRAINT medication_pkey PRIMARY KEY (id);


--
-- Name: menstrual_period menstrual_period_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.menstrual_period
    ADD CONSTRAINT menstrual_period_pkey PRIMARY KEY (id);


--
-- Name: nutrient nutrient_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.nutrient
    ADD CONSTRAINT nutrient_pkey PRIMARY KEY (id);


--
-- Name: nutrition_daily nutrition_daily_date_provider_id_pk; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.nutrition_daily
    ADD CONSTRAINT nutrition_daily_date_provider_id_pk PRIMARY KEY (date, provider_id);


--
-- Name: nutrition_data nutrition_data_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.nutrition_data
    ADD CONSTRAINT nutrition_data_pkey PRIMARY KEY (id);


--
-- Name: provider provider_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.provider
    ADD CONSTRAINT provider_pkey PRIMARY KEY (id);


--
-- Name: provider_priority provider_priority_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.provider_priority
    ADD CONSTRAINT provider_priority_pkey PRIMARY KEY (provider_id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: shared_report shared_report_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.shared_report
    ADD CONSTRAINT shared_report_pkey PRIMARY KEY (id);


--
-- Name: shared_report shared_report_share_token_key; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.shared_report
    ADD CONSTRAINT shared_report_share_token_key UNIQUE (share_token);


--
-- Name: slack_installation slack_installation_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.slack_installation
    ADD CONSTRAINT slack_installation_pkey PRIMARY KEY (id);


--
-- Name: slack_installation slack_installation_team_unique; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.slack_installation
    ADD CONSTRAINT slack_installation_team_unique UNIQUE (team_id);


--
-- Name: sleep_session sleep_session_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sleep_session
    ADD CONSTRAINT sleep_session_pkey PRIMARY KEY (id);


--
-- Name: sleep_stage sleep_stage_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sleep_stage
    ADD CONSTRAINT sleep_stage_pkey PRIMARY KEY (id);


--
-- Name: sport_settings sport_settings_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sport_settings
    ADD CONSTRAINT sport_settings_pkey PRIMARY KEY (id);


--
-- Name: strength_set strength_set_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.strength_set
    ADD CONSTRAINT strength_set_pkey PRIMARY KEY (id);


--
-- Name: strength_workout strength_workout_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.strength_workout
    ADD CONSTRAINT strength_workout_pkey PRIMARY KEY (id);


--
-- Name: supplement_nutrient supplement_nutrient_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement_nutrient
    ADD CONSTRAINT supplement_nutrient_pkey PRIMARY KEY (supplement_id, nutrient_id);


--
-- Name: supplement_nutrition supplement_nutrition_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement_nutrition
    ADD CONSTRAINT supplement_nutrition_pkey PRIMARY KEY (id);


--
-- Name: supplement_nutrition supplement_nutrition_supplement_id_unique; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement_nutrition
    ADD CONSTRAINT supplement_nutrition_supplement_id_unique UNIQUE (supplement_id);


--
-- Name: supplement supplement_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement
    ADD CONSTRAINT supplement_pkey PRIMARY KEY (id);


--
-- Name: sync_log sync_log_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sync_log
    ADD CONSTRAINT sync_log_pkey PRIMARY KEY (id);


--
-- Name: training_export_watermark training_export_watermark_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.training_export_watermark
    ADD CONSTRAINT training_export_watermark_pkey PRIMARY KEY (id);


--
-- Name: training_export_watermark training_export_watermark_table_name_key; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.training_export_watermark
    ADD CONSTRAINT training_export_watermark_table_name_key UNIQUE (table_name);


--
-- Name: user_profile user_profile_email_key; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.user_profile
    ADD CONSTRAINT user_profile_email_key UNIQUE (email);


--
-- Name: user_profile user_profile_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.user_profile
    ADD CONSTRAINT user_profile_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id, key);


--
-- Name: webhook_subscription webhook_subscription_pkey; Type: CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.webhook_subscription
    ADD CONSTRAINT webhook_subscription_pkey PRIMARY KEY (id);


--
-- Name: _materialized_hypertable_10_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_10_bucket_idx ON _timescaledb_internal._materialized_hypertable_10 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_10_channel_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_10_channel_bucket_idx ON _timescaledb_internal._materialized_hypertable_10 USING btree (channel, bucket DESC);


--
-- Name: _materialized_hypertable_10_user_id_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_10_user_id_bucket_idx ON _timescaledb_internal._materialized_hypertable_10 USING btree (user_id, bucket DESC);


--
-- Name: _materialized_hypertable_11_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_11_bucket_idx ON _timescaledb_internal._materialized_hypertable_11 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_11_channel_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_11_channel_bucket_idx ON _timescaledb_internal._materialized_hypertable_11 USING btree (channel, bucket DESC);


--
-- Name: _materialized_hypertable_11_user_id_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_11_user_id_bucket_idx ON _timescaledb_internal._materialized_hypertable_11 USING btree (user_id, bucket DESC);


--
-- Name: _materialized_hypertable_3_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_3_bucket_idx ON _timescaledb_internal._materialized_hypertable_3 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_3_user_id_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_3_user_id_bucket_idx ON _timescaledb_internal._materialized_hypertable_3 USING btree (user_id, bucket DESC);


--
-- Name: _materialized_hypertable_4_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_4_bucket_idx ON _timescaledb_internal._materialized_hypertable_4 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_4_user_id_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: -
--

CREATE INDEX _materialized_hypertable_4_user_id_bucket_idx ON _timescaledb_internal._materialized_hypertable_4 USING btree (user_id, bucket DESC);


--
-- Name: activity_interval_activity_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX activity_interval_activity_idx ON fitness.activity_interval USING btree (activity_id, interval_index);


--
-- Name: activity_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX activity_provider_external_idx ON fitness.activity USING btree (user_id, provider_id, external_id);


--
-- Name: activity_started_at_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX activity_started_at_idx ON fitness.activity USING btree (started_at DESC);


--
-- Name: activity_summary_pk; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX activity_summary_pk ON fitness.activity_summary USING btree (activity_id);


--
-- Name: activity_summary_user_time; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX activity_summary_user_time ON fitness.activity_summary USING btree (user_id, started_at DESC);


--
-- Name: activity_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX activity_user_provider_idx ON fitness.activity USING btree (user_id, provider_id);


--
-- Name: allergy_intolerance_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX allergy_intolerance_provider_external_idx ON fitness.allergy_intolerance USING btree (user_id, provider_id, external_id);


--
-- Name: allergy_intolerance_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX allergy_intolerance_user_provider_idx ON fitness.allergy_intolerance USING btree (user_id, provider_id);


--
-- Name: auth_account_email_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX auth_account_email_idx ON fitness.auth_account USING btree (email) WHERE (email IS NOT NULL);


--
-- Name: auth_account_provider_id_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX auth_account_provider_id_idx ON fitness.auth_account USING btree (auth_provider, provider_account_id);


--
-- Name: auth_account_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX auth_account_user_idx ON fitness.auth_account USING btree (user_id);


--
-- Name: body_measurement_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX body_measurement_provider_external_idx ON fitness.body_measurement USING btree (user_id, provider_id, external_id);


--
-- Name: body_measurement_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX body_measurement_user_provider_idx ON fitness.body_measurement USING btree (user_id, provider_id);


--
-- Name: body_measurement_user_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX body_measurement_user_time_idx ON fitness.body_measurement USING btree (user_id, recorded_at DESC);


--
-- Name: body_measurement_value_entry_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX body_measurement_value_entry_idx ON fitness.body_measurement_value USING btree (body_measurement_id);


--
-- Name: body_measurement_value_type_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX body_measurement_value_type_idx ON fitness.body_measurement_value USING btree (measurement_type_id);


--
-- Name: breathwork_session_started_at_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX breathwork_session_started_at_idx ON fitness.breathwork_session USING btree (started_at DESC);


--
-- Name: breathwork_session_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX breathwork_session_user_idx ON fitness.breathwork_session USING btree (user_id);


--
-- Name: condition_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX condition_provider_external_idx ON fitness.condition USING btree (user_id, provider_id, external_id);


--
-- Name: condition_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX condition_user_provider_idx ON fitness.condition USING btree (user_id, provider_id);


--
-- Name: daily_metric_value_entry_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX daily_metric_value_entry_idx ON fitness.daily_metric_value USING btree (daily_metrics_id);


--
-- Name: daily_metric_value_type_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX daily_metric_value_type_idx ON fitness.daily_metric_value USING btree (metric_type_id);


--
-- Name: daily_metrics_date_provider_source_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX daily_metrics_date_provider_source_idx ON fitness.daily_metrics USING btree (user_id, date, provider_id, source_name) NULLS NOT DISTINCT;


--
-- Name: daily_metrics_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX daily_metrics_user_provider_idx ON fitness.daily_metrics USING btree (user_id, provider_id);


--
-- Name: deduped_sensor_activity_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX deduped_sensor_activity_time_idx ON fitness.deduped_sensor USING btree (activity_id, recorded_at);


--
-- Name: deduped_sensor_pk; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX deduped_sensor_pk ON fitness.deduped_sensor USING btree (activity_id, channel, recorded_at);


--
-- Name: dexa_scan_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX dexa_scan_provider_external_idx ON fitness.dexa_scan USING btree (user_id, provider_id, external_id);


--
-- Name: dexa_scan_recorded_at_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX dexa_scan_recorded_at_idx ON fitness.dexa_scan USING btree (recorded_at DESC);


--
-- Name: dexa_scan_region_scan_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX dexa_scan_region_scan_idx ON fitness.dexa_scan_region USING btree (scan_id);


--
-- Name: dexa_scan_region_scan_region_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX dexa_scan_region_scan_region_idx ON fitness.dexa_scan_region USING btree (scan_id, region);


--
-- Name: dexa_scan_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX dexa_scan_user_provider_idx ON fitness.dexa_scan USING btree (user_id, provider_id);


--
-- Name: exercise_alias_provider_name_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX exercise_alias_provider_name_idx ON fitness.exercise_alias USING btree (provider_id, provider_exercise_name);


--
-- Name: exercise_name_equipment_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX exercise_name_equipment_idx ON fitness.exercise USING btree (name, equipment);


--
-- Name: food_entry_confirmed_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX food_entry_confirmed_idx ON fitness.food_entry USING btree (confirmed) WHERE (confirmed = false);


--
-- Name: food_entry_date_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX food_entry_date_idx ON fitness.food_entry USING btree (date);


--
-- Name: food_entry_date_meal_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX food_entry_date_meal_idx ON fitness.food_entry USING btree (date, meal);


--
-- Name: food_entry_food_name_trgm_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX food_entry_food_name_trgm_idx ON fitness.food_entry USING gin (food_name health.gin_trgm_ops);


--
-- Name: food_entry_nutrient_entry_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX food_entry_nutrient_entry_idx ON fitness.food_entry_nutrient USING btree (food_entry_id);


--
-- Name: food_entry_nutrition_entry_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX food_entry_nutrition_entry_idx ON fitness.food_entry_nutrition USING btree (food_entry_id);


--
-- Name: food_entry_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX food_entry_provider_external_idx ON fitness.food_entry USING btree (user_id, provider_id, external_id);


--
-- Name: food_entry_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX food_entry_user_provider_idx ON fitness.food_entry USING btree (user_id, provider_id);


--
-- Name: health_event_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX health_event_provider_external_idx ON fitness.health_event USING btree (user_id, provider_id, external_id);


--
-- Name: health_event_type_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX health_event_type_time_idx ON fitness.health_event USING btree (type, start_date);


--
-- Name: health_event_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX health_event_user_provider_idx ON fitness.health_event USING btree (user_id, provider_id);


--
-- Name: journal_entry_date_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX journal_entry_date_idx ON fitness.journal_entry USING btree (date);


--
-- Name: journal_entry_question_slug_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX journal_entry_question_slug_idx ON fitness.journal_entry USING btree (question_slug);


--
-- Name: journal_entry_user_date_question_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX journal_entry_user_date_question_provider_idx ON fitness.journal_entry USING btree (user_id, date, question_slug, provider_id);


--
-- Name: journal_entry_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX journal_entry_user_provider_idx ON fitness.journal_entry USING btree (user_id, provider_id);


--
-- Name: lab_panel_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX lab_panel_provider_external_idx ON fitness.lab_panel USING btree (user_id, provider_id, external_id);


--
-- Name: lab_panel_recorded_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX lab_panel_recorded_idx ON fitness.lab_panel USING btree (recorded_at);


--
-- Name: lab_panel_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX lab_panel_user_provider_idx ON fitness.lab_panel USING btree (user_id, provider_id);


--
-- Name: lab_result_loinc_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX lab_result_loinc_idx ON fitness.lab_result USING btree (loinc_code);


--
-- Name: lab_result_panel_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX lab_result_panel_idx ON fitness.lab_result USING btree (panel_id);


--
-- Name: lab_result_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX lab_result_provider_external_idx ON fitness.lab_result USING btree (user_id, provider_id, external_id);


--
-- Name: lab_result_recorded_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX lab_result_recorded_idx ON fitness.lab_result USING btree (recorded_at);


--
-- Name: lab_result_test_name_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX lab_result_test_name_idx ON fitness.lab_result USING btree (test_name);


--
-- Name: lab_result_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX lab_result_user_provider_idx ON fitness.lab_result USING btree (user_id, provider_id);


--
-- Name: life_events_started_at_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX life_events_started_at_idx ON fitness.life_events USING btree (started_at);


--
-- Name: medication_dose_event_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX medication_dose_event_provider_external_idx ON fitness.medication_dose_event USING btree (user_id, provider_id, external_id);


--
-- Name: medication_dose_event_recorded_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX medication_dose_event_recorded_idx ON fitness.medication_dose_event USING btree (recorded_at);


--
-- Name: medication_dose_event_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX medication_dose_event_user_provider_idx ON fitness.medication_dose_event USING btree (user_id, provider_id);


--
-- Name: medication_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX medication_provider_external_idx ON fitness.medication USING btree (user_id, provider_id, external_id);


--
-- Name: medication_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX medication_user_provider_idx ON fitness.medication USING btree (user_id, provider_id);


--
-- Name: menstrual_period_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX menstrual_period_user_idx ON fitness.menstrual_period USING btree (user_id);


--
-- Name: menstrual_period_user_start_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX menstrual_period_user_start_idx ON fitness.menstrual_period USING btree (user_id, start_date);


--
-- Name: metric_stream_activity_channel_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX metric_stream_activity_channel_time_idx ON fitness.metric_stream USING btree (activity_id, channel, recorded_at);


--
-- Name: metric_stream_provider_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX metric_stream_provider_time_idx ON fitness.metric_stream USING btree (provider_id, recorded_at);


--
-- Name: metric_stream_recorded_at_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX metric_stream_recorded_at_idx ON fitness.metric_stream USING btree (recorded_at DESC);


--
-- Name: metric_stream_user_channel_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX metric_stream_user_channel_time_idx ON fitness.metric_stream USING btree (user_id, channel, recorded_at);


--
-- Name: nutrition_daily_user_date_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX nutrition_daily_user_date_idx ON fitness.nutrition_daily USING btree (user_id, date DESC);


--
-- Name: nutrition_daily_user_date_provider_uidx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX nutrition_daily_user_date_provider_uidx ON fitness.nutrition_daily USING btree (user_id, date, provider_id);


--
-- Name: nutrition_daily_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX nutrition_daily_user_provider_idx ON fitness.nutrition_daily USING btree (user_id, provider_id);


--
-- Name: oauth_token_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX oauth_token_provider_idx ON fitness.oauth_token USING btree (provider_id);


--
-- Name: oauth_token_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX oauth_token_user_idx ON fitness.oauth_token USING btree (user_id);


--
-- Name: oauth_token_user_provider_uidx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX oauth_token_user_provider_uidx ON fitness.oauth_token USING btree (user_id, provider_id);


--
-- Name: provider_stats_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX provider_stats_user_provider_idx ON fitness.provider_stats USING btree (user_id, provider_id);


--
-- Name: provider_user_name_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX provider_user_name_idx ON fitness.provider USING btree (user_id, name);


--
-- Name: session_expires_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX session_expires_idx ON fitness.session USING btree (expires_at);


--
-- Name: session_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX session_user_idx ON fitness.session USING btree (user_id);


--
-- Name: shared_report_token_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX shared_report_token_idx ON fitness.shared_report USING btree (share_token);


--
-- Name: shared_report_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX shared_report_user_idx ON fitness.shared_report USING btree (user_id);


--
-- Name: slack_installation_team_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX slack_installation_team_idx ON fitness.slack_installation USING btree (team_id);


--
-- Name: sleep_session_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX sleep_session_provider_external_idx ON fitness.sleep_session USING btree (user_id, provider_id, external_id);


--
-- Name: sleep_session_started_at_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX sleep_session_started_at_idx ON fitness.sleep_session USING btree (started_at DESC);


--
-- Name: sleep_session_user_provider_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX sleep_session_user_provider_idx ON fitness.sleep_session USING btree (user_id, provider_id);


--
-- Name: sleep_stage_session_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX sleep_stage_session_idx ON fitness.sleep_stage USING btree (session_id, started_at);


--
-- Name: sport_settings_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX sport_settings_user_idx ON fitness.sport_settings USING btree (user_id);


--
-- Name: sport_settings_user_sport_date_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX sport_settings_user_sport_date_idx ON fitness.sport_settings USING btree (user_id, sport, effective_from);


--
-- Name: strength_set_workout_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX strength_set_workout_idx ON fitness.strength_set USING btree (workout_id);


--
-- Name: strength_workout_provider_external_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX strength_workout_provider_external_idx ON fitness.strength_workout USING btree (user_id, provider_id, external_id);


--
-- Name: strength_workout_user_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX strength_workout_user_time_idx ON fitness.strength_workout USING btree (user_id, started_at DESC);


--
-- Name: supplement_nutrient_supplement_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX supplement_nutrient_supplement_idx ON fitness.supplement_nutrient USING btree (supplement_id);


--
-- Name: supplement_nutrition_supplement_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX supplement_nutrition_supplement_idx ON fitness.supplement_nutrition USING btree (supplement_id);


--
-- Name: supplement_user_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX supplement_user_idx ON fitness.supplement USING btree (user_id);


--
-- Name: supplement_user_name_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX supplement_user_name_idx ON fitness.supplement USING btree (user_id, name);


--
-- Name: sync_log_provider_type_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX sync_log_provider_type_idx ON fitness.sync_log USING btree (provider_id, data_type, synced_at);


--
-- Name: sync_log_synced_at_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX sync_log_synced_at_idx ON fitness.sync_log USING btree (synced_at DESC);


--
-- Name: v_activity_id_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX v_activity_id_idx ON fitness.v_activity USING btree (id);


--
-- Name: v_activity_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX v_activity_time_idx ON fitness.v_activity USING btree (started_at DESC);


--
-- Name: v_activity_user_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX v_activity_user_time_idx ON fitness.v_activity USING btree (user_id, started_at DESC);


--
-- Name: v_body_measurement_id_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX v_body_measurement_id_idx ON fitness.v_body_measurement USING btree (id);


--
-- Name: v_body_measurement_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX v_body_measurement_time_idx ON fitness.v_body_measurement USING btree (recorded_at DESC);


--
-- Name: v_daily_metrics_date_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX v_daily_metrics_date_idx ON fitness.v_daily_metrics USING btree (date, user_id);


--
-- Name: v_metric_stream_activity_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX v_metric_stream_activity_time_idx ON fitness.v_metric_stream USING btree (activity_id, recorded_at);


--
-- Name: v_metric_stream_user_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX v_metric_stream_user_time_idx ON fitness.v_metric_stream USING btree (user_id, recorded_at);


--
-- Name: v_sleep_id_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX v_sleep_id_idx ON fitness.v_sleep USING btree (id);


--
-- Name: v_sleep_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX v_sleep_time_idx ON fitness.v_sleep USING btree (started_at DESC);


--
-- Name: v_sleep_user_nap_time_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX v_sleep_user_nap_time_idx ON fitness.v_sleep USING btree (user_id, is_nap, started_at DESC);


--
-- Name: webhook_subscription_provider_id_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE UNIQUE INDEX webhook_subscription_provider_id_idx ON fitness.webhook_subscription USING btree (provider_id);


--
-- Name: webhook_subscription_provider_name_idx; Type: INDEX; Schema: fitness; Owner: -
--

CREATE INDEX webhook_subscription_provider_name_idx ON fitness.webhook_subscription USING btree (provider_name);


--
-- Name: activity_interval activity_interval_activity_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.activity_interval
    ADD CONSTRAINT activity_interval_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES fitness.activity(id) ON DELETE CASCADE;


--
-- Name: activity activity_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.activity
    ADD CONSTRAINT activity_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: allergy_intolerance allergy_intolerance_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.allergy_intolerance
    ADD CONSTRAINT allergy_intolerance_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: allergy_intolerance allergy_intolerance_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.allergy_intolerance
    ADD CONSTRAINT allergy_intolerance_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: auth_account auth_account_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.auth_account
    ADD CONSTRAINT auth_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id) ON DELETE CASCADE;


--
-- Name: body_measurement body_measurement_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.body_measurement
    ADD CONSTRAINT body_measurement_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: body_measurement body_measurement_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.body_measurement
    ADD CONSTRAINT body_measurement_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: body_measurement_value body_measurement_value_body_measurement_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.body_measurement_value
    ADD CONSTRAINT body_measurement_value_body_measurement_id_fkey FOREIGN KEY (body_measurement_id) REFERENCES fitness.body_measurement(id) ON DELETE CASCADE;


--
-- Name: body_measurement_value body_measurement_value_measurement_type_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.body_measurement_value
    ADD CONSTRAINT body_measurement_value_measurement_type_id_fkey FOREIGN KEY (measurement_type_id) REFERENCES fitness.measurement_type(id);


--
-- Name: breathwork_session breathwork_session_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.breathwork_session
    ADD CONSTRAINT breathwork_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: activity cardio_activity_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.activity
    ADD CONSTRAINT cardio_activity_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: condition condition_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.condition
    ADD CONSTRAINT condition_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: condition condition_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.condition
    ADD CONSTRAINT condition_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: daily_metric_value daily_metric_value_daily_metrics_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.daily_metric_value
    ADD CONSTRAINT daily_metric_value_daily_metrics_id_fkey FOREIGN KEY (daily_metrics_id) REFERENCES fitness.daily_metrics(id) ON DELETE CASCADE;


--
-- Name: daily_metric_value daily_metric_value_metric_type_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.daily_metric_value
    ADD CONSTRAINT daily_metric_value_metric_type_id_fkey FOREIGN KEY (metric_type_id) REFERENCES fitness.daily_metric_type(id);


--
-- Name: daily_metrics daily_metrics_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.daily_metrics
    ADD CONSTRAINT daily_metrics_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: daily_metrics daily_metrics_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.daily_metrics
    ADD CONSTRAINT daily_metrics_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: dexa_scan dexa_scan_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.dexa_scan
    ADD CONSTRAINT dexa_scan_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: dexa_scan_region dexa_scan_region_scan_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.dexa_scan_region
    ADD CONSTRAINT dexa_scan_region_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES fitness.dexa_scan(id) ON DELETE CASCADE;


--
-- Name: dexa_scan dexa_scan_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.dexa_scan
    ADD CONSTRAINT dexa_scan_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: exercise_alias exercise_alias_exercise_id_exercise_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.exercise_alias
    ADD CONSTRAINT exercise_alias_exercise_id_exercise_id_fk FOREIGN KEY (exercise_id) REFERENCES fitness.exercise(id);


--
-- Name: exercise_alias exercise_alias_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.exercise_alias
    ADD CONSTRAINT exercise_alias_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: food_entry_nutrient food_entry_nutrient_food_entry_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry_nutrient
    ADD CONSTRAINT food_entry_nutrient_food_entry_id_fkey FOREIGN KEY (food_entry_id) REFERENCES fitness.food_entry(id) ON DELETE CASCADE;


--
-- Name: food_entry_nutrient food_entry_nutrient_nutrient_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry_nutrient
    ADD CONSTRAINT food_entry_nutrient_nutrient_id_fkey FOREIGN KEY (nutrient_id) REFERENCES fitness.nutrient(id);


--
-- Name: food_entry_nutrition food_entry_nutrition_food_entry_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry_nutrition
    ADD CONSTRAINT food_entry_nutrition_food_entry_id_fkey FOREIGN KEY (food_entry_id) REFERENCES fitness.food_entry(id) ON DELETE CASCADE;


--
-- Name: food_entry food_entry_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry
    ADD CONSTRAINT food_entry_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: food_entry food_entry_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.food_entry
    ADD CONSTRAINT food_entry_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: health_event health_event_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.health_event
    ADD CONSTRAINT health_event_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: health_event health_event_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.health_event
    ADD CONSTRAINT health_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: journal_entry journal_entry_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.journal_entry
    ADD CONSTRAINT journal_entry_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: journal_entry journal_entry_question_slug_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.journal_entry
    ADD CONSTRAINT journal_entry_question_slug_fk FOREIGN KEY (question_slug) REFERENCES fitness.journal_question(slug);


--
-- Name: journal_entry journal_entry_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.journal_entry
    ADD CONSTRAINT journal_entry_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: lab_panel lab_panel_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.lab_panel
    ADD CONSTRAINT lab_panel_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: lab_panel lab_panel_user_id_user_profile_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.lab_panel
    ADD CONSTRAINT lab_panel_user_id_user_profile_id_fk FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: lab_result lab_result_panel_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.lab_result
    ADD CONSTRAINT lab_result_panel_id_fkey FOREIGN KEY (panel_id) REFERENCES fitness.lab_panel(id);


--
-- Name: lab_result lab_result_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.lab_result
    ADD CONSTRAINT lab_result_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: lab_result lab_result_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.lab_result
    ADD CONSTRAINT lab_result_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: life_events life_events_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.life_events
    ADD CONSTRAINT life_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: medication_dose_event medication_dose_event_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.medication_dose_event
    ADD CONSTRAINT medication_dose_event_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: medication_dose_event medication_dose_event_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.medication_dose_event
    ADD CONSTRAINT medication_dose_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: medication medication_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.medication
    ADD CONSTRAINT medication_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: medication medication_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.medication
    ADD CONSTRAINT medication_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: menstrual_period menstrual_period_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.menstrual_period
    ADD CONSTRAINT menstrual_period_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: nutrition_daily nutrition_daily_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.nutrition_daily
    ADD CONSTRAINT nutrition_daily_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: nutrition_daily nutrition_daily_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.nutrition_daily
    ADD CONSTRAINT nutrition_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: oauth_token oauth_token_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.oauth_token
    ADD CONSTRAINT oauth_token_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: oauth_token oauth_token_user_id_user_profile_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.oauth_token
    ADD CONSTRAINT oauth_token_user_id_user_profile_id_fk FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: provider provider_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.provider
    ADD CONSTRAINT provider_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: metric_stream sensor_sample_activity_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.metric_stream
    ADD CONSTRAINT sensor_sample_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES fitness.activity(id) ON DELETE CASCADE;


--
-- Name: metric_stream sensor_sample_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.metric_stream
    ADD CONSTRAINT sensor_sample_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: metric_stream sensor_sample_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.metric_stream
    ADD CONSTRAINT sensor_sample_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: session session_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id) ON DELETE CASCADE;


--
-- Name: shared_report shared_report_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.shared_report
    ADD CONSTRAINT shared_report_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: sleep_session sleep_session_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sleep_session
    ADD CONSTRAINT sleep_session_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: sleep_session sleep_session_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sleep_session
    ADD CONSTRAINT sleep_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: sleep_stage sleep_stage_session_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sleep_stage
    ADD CONSTRAINT sleep_stage_session_id_fkey FOREIGN KEY (session_id) REFERENCES fitness.sleep_session(id) ON DELETE CASCADE;


--
-- Name: sport_settings sport_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sport_settings
    ADD CONSTRAINT sport_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: strength_set strength_set_exercise_id_exercise_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.strength_set
    ADD CONSTRAINT strength_set_exercise_id_exercise_id_fk FOREIGN KEY (exercise_id) REFERENCES fitness.exercise(id);


--
-- Name: strength_set strength_set_workout_id_strength_workout_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.strength_set
    ADD CONSTRAINT strength_set_workout_id_strength_workout_id_fk FOREIGN KEY (workout_id) REFERENCES fitness.strength_workout(id) ON DELETE CASCADE;


--
-- Name: strength_workout strength_workout_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.strength_workout
    ADD CONSTRAINT strength_workout_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: strength_workout strength_workout_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.strength_workout
    ADD CONSTRAINT strength_workout_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: supplement_nutrient supplement_nutrient_nutrient_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement_nutrient
    ADD CONSTRAINT supplement_nutrient_nutrient_id_fkey FOREIGN KEY (nutrient_id) REFERENCES fitness.nutrient(id);


--
-- Name: supplement_nutrient supplement_nutrient_supplement_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement_nutrient
    ADD CONSTRAINT supplement_nutrient_supplement_id_fkey FOREIGN KEY (supplement_id) REFERENCES fitness.supplement(id) ON DELETE CASCADE;


--
-- Name: supplement_nutrition supplement_nutrition_supplement_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement_nutrition
    ADD CONSTRAINT supplement_nutrition_supplement_id_fkey FOREIGN KEY (supplement_id) REFERENCES fitness.supplement(id) ON DELETE CASCADE;


--
-- Name: supplement supplement_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.supplement
    ADD CONSTRAINT supplement_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: sync_log sync_log_provider_id_provider_id_fk; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sync_log
    ADD CONSTRAINT sync_log_provider_id_provider_id_fk FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- Name: sync_log sync_log_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.sync_log
    ADD CONSTRAINT sync_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id);


--
-- Name: webhook_subscription webhook_subscription_provider_id_fkey; Type: FK CONSTRAINT; Schema: fitness; Owner: -
--

ALTER TABLE ONLY fitness.webhook_subscription
    ADD CONSTRAINT webhook_subscription_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES fitness.provider(id);


--
-- PostgreSQL database dump complete
--


--
-- Timescale hypertable metadata is not represented as ordinary schema DDL by pg_dump.
--

SELECT public.create_hypertable(
  'fitness.metric_stream'::regclass,
  'recorded_at'::name,
  if_not_exists => TRUE
);

SELECT public.set_chunk_time_interval('fitness.metric_stream', INTERVAL '1 day');

ALTER TABLE fitness.metric_stream
SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'user_id,provider_id,channel',
  timescaledb.compress_orderby = 'recorded_at DESC'
);

SELECT public.add_compression_policy(
  'fitness.metric_stream',
  compress_after => INTERVAL '7 days',
  if_not_exists => true
);


--
-- Bootstrap data preserved from compacted migration history.
--

INSERT INTO fitness.journal_question (slug, display_name, category, data_type, sort_order)
VALUES
  ('caffeine', 'Caffeine', 'substance', 'boolean', 1),
  ('alcohol', 'Alcohol', 'substance', 'boolean', 2),
  ('melatonin', 'Melatonin', 'substance', 'boolean', 3),
  ('sleep_aid', 'Sleep Aid', 'substance', 'boolean', 4),
  ('meditation', 'Meditation', 'activity', 'boolean', 10),
  ('morning_stretch', 'Morning Stretch', 'activity', 'boolean', 11),
  ('hydration', 'Hydration', 'wellness', 'numeric', 20),
  ('sleep_quality', 'Sleep Quality', 'wellness', 'numeric', 21),
  ('energy', 'Energy', 'wellness', 'numeric', 22),
  ('mood', 'Mood', 'wellness', 'numeric', 23),
  ('recovery', 'Recovery', 'wellness', 'numeric', 24)
ON CONFLICT (slug) DO NOTHING;
