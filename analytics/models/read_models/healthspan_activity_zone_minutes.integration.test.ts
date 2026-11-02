import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../src/db/clickhouse.ts";
import { readModelSql, renderDbtModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

describe("healthspan uses applicable computed cycling power",()=>{
  const client=createClickHouseClientFromEnv();
  const database=`cycling_healthspan_${randomUUID().replaceAll("-","")}`;
  const user=randomUUID();const supported=randomUUID();const unavailable=randomUUID();
  beforeAll(async()=>{
    await client.command({query:`CREATE DATABASE ${database}`});
    for(const definition of [
      "activity_summary_rows (activity_id UUID,user_id UUID,canonical_type String,started_at DateTime64(6),ended_at Nullable(DateTime64(6)),is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY activity_id",
      "user_profile_current (id UUID,max_hr Nullable(Int16),resting_hr Nullable(Int16)) ENGINE=Memory",
      "resting_heart_rate_sleep_window (user_id UUID,ended_at Nullable(DateTime64(6)),resting_hr Nullable(Float64),is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY user_id",
      "cycling_activity_power_metrics (user_id UUID,activity_id UUID,eftp Nullable(Float64)) ENGINE=Memory",
      "activity_sensor_sample (user_id UUID,activity_id UUID,recorded_at DateTime64(6),channel String,scalar Nullable(Float64),is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,activity_id,channel,recorded_at)",
      "healthspan_activity_zone_minutes (activity_id UUID,user_id UUID,started_at Nullable(DateTime64(6)),ended_at Nullable(DateTime64(6)),aerobic_minutes Nullable(Float64),high_intensity_minutes Nullable(Float64),is_deleted UInt8,refresh_version UInt64,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)",
      "daily_sleep (user_id UUID,started_at DateTime64(6),duration_minutes Nullable(Float64),is_deleted UInt8,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree ORDER BY (user_id,started_at)",
      "v_daily_metrics (user_id UUID,date Date,steps Nullable(Float64),exercise_minutes Nullable(Float64)) ENGINE=Memory",
      "activity_vo2max_estimate (user_id UUID,started_at DateTime64(6),vo2max Nullable(Float64),is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,started_at)",
      "daily_body_measurement (user_id UUID,date Date,weight_kg Nullable(Float64),body_fat_pct Nullable(Float64),recorded_at DateTime64(6),refresh_version UInt64,measurement_id UUID,is_deleted UInt8,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree ORDER BY (user_id,date)",
      "weekly_healthspan (user_id UUID,week_start Date,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree ORDER BY (user_id,week_start)",
    ]) await client.command({query:`CREATE TABLE ${database}.${definition}`});
    await client.command({query:`CREATE VIEW ${database}.deduped_activities AS SELECT * FROM ${database}.activity_summary_rows FINAL`});
    await client.command({query:`INSERT INTO ${database}.user_profile_current VALUES ('${user}',NULL,50)`});
    for(const id of [supported,unavailable]) {
      await client.command({query:`INSERT INTO ${database}.activity_summary_rows VALUES ('${id}','${user}','cycling','2026-01-01 12:00:00','2026-01-01 12:10:00',0)`});
      await client.command({query:`INSERT INTO ${database}.activity_sensor_sample SELECT toUUID('${user}'),toUUID('${id}'),toDateTime64('2026-01-01 12:00:00',6)+toIntervalSecond(number*5),'power',220.0,0 FROM numbers(60)`});
    }
    await client.command({query:`INSERT INTO ${database}.cycling_activity_power_metrics VALUES ('${user}','${supported}',240)`});
  });
  afterAll(async()=>{await client.command({query:`DROP DATABASE IF EXISTS ${database}`});await client.close?.();});
  const run=async()=>{
    const query=renderDbtModelSql(readModelSql("healthspan_activity_zone_minutes.sql"),{isIncremental:false})
      .replace(/{{ ref\('([^']+)'\) }}/g,`${database}.$1`)
      .replace(/{{ source\('[^']+', '([^']+)'\) }}/g,`${database}.$1`)
      .concat("\nSETTINGS join_use_nulls=1,max_threads=1");
    const result=await client.query({query,format:"JSONEachRow"});return result.json<Record<string,unknown>>();
  };
  const render=(name:string,isIncremental:boolean)=>renderDbtModelSql(readModelSql(name),{isIncremental})
    .replaceAll("{{ this }}",`${database}.${name.replace(".sql","")}`)
    .replace(/{{ ref\('([^']+)'\) }}/g,`${database}.$1`)
    .replace(/{{ source\('[^']+', '([^']+)'\) }}/g,`${database}.$1`);
  it("counts observed elapsed time without scaling partial power coverage to the full ride",async()=>{
    const rows=await run();
    expect(rows.find(row=>row.activity_id===supported)?.high_intensity_minutes).toBe(5);
    expect(rows.find(row=>row.activity_id===supported)?.aerobic_minutes).toBeNull();
  });
  it("keeps unsupported power intensity unknown rather than zero",async()=>{
    const rows=await run();
    expect(rows.find(row=>row.activity_id===unavailable)?.high_intensity_minutes).toBeNull();
    expect(rows.find(row=>row.activity_id===unavailable)?.is_deleted).toBe(0);
  });
  it("preserves unknown intensity in the weekly projection",async()=>{
    await client.command({query:`INSERT INTO ${database}.healthspan_activity_zone_minutes ${render("healthspan_activity_zone_minutes.sql",false)} SETTINGS join_use_nulls=1`});
    const result=await client.query({query:render("weekly_healthspan.sql",false)+"\nSETTINGS join_use_nulls=1",format:"JSONEachRow"});
    const rows=await result.json<Record<string,unknown>>();
    expect(rows.find(row=>row.user_id===user)?.weekly_high_intensity_min).toBeNull();
  });
  it("refreshes corrected intensity weeks older than the ordinary lookback",async()=>{
    await client.command({query:`INSERT INTO ${database}.weekly_healthspan VALUES ('${user}','2026-10-26','2026-10-26 00:00:00')`});
    const result=await client.query({query:render("weekly_healthspan.sql",true)+"\nSETTINGS join_use_nulls=1",format:"JSONEachRow"});
    const rows=await result.json<Record<string,unknown>>();
    expect(rows.find(row=>row.user_id===user&&row.week_start==="2025-12-29")).toBeDefined();
  });
  it("retains the previous activity date when emitting deletion tombstones",async()=>{
    const deleted=randomUUID();
    await client.command({query:`INSERT INTO ${database}.healthspan_activity_zone_minutes VALUES ('${deleted}','${user}','2020-01-01 12:00:00','2020-01-01 12:10:00',0,5,0,1,'2020-01-01 12:10:00')`});
    const result=await client.query({query:render("healthspan_activity_zone_minutes.sql",true)+"\nSETTINGS join_use_nulls=1",format:"JSONEachRow"});
    const rows=await result.json<Record<string,unknown>>();
    const tombstone=rows.find(row=>row.activity_id===deleted);
    expect(tombstone?.is_deleted).toBe(1);
    expect(String(tombstone?.started_at)).toContain("2020-01-01");
  });
});
