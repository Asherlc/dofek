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
      "activity_summary_rows (activity_id UUID,user_id UUID,canonical_type String,started_at DateTime64(6),ended_at Nullable(DateTime64(6)),is_deleted UInt8,refreshed_at DateTime64(9) DEFAULT now64(9)) ENGINE=ReplacingMergeTree ORDER BY activity_id",
      "user_profile_current (id UUID,max_hr Nullable(Int16),resting_hr Nullable(Int16),updated_at DateTime64(9) DEFAULT now64(9)) ENGINE=Memory",
      "resting_heart_rate_sleep_window (user_id UUID,ended_at Nullable(DateTime64(6)),resting_hr Nullable(Float64),is_deleted UInt8,refreshed_at DateTime64(9) DEFAULT now64(9)) ENGINE=ReplacingMergeTree ORDER BY user_id",
      "cycling_activity_power_metrics (user_id UUID,activity_id UUID,eftp Nullable(Float64),refreshed_at DateTime64(9) DEFAULT now64(9)) ENGINE=MergeTree ORDER BY (user_id,activity_id)",
      "activity_sensor_sample (user_id UUID,activity_id UUID,recorded_at DateTime64(6),channel String,scalar Nullable(Float64),is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,activity_id,channel,recorded_at)",
      "healthspan_activity_zone_minutes (activity_id UUID,user_id UUID,started_at Nullable(DateTime64(6)),ended_at Nullable(DateTime64(6)),aerobic_minutes Nullable(Float64),high_intensity_minutes Nullable(Float64),is_deleted UInt8,refresh_version UInt64,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)",
      "daily_sleep (user_id UUID,started_at DateTime64(6),duration_minutes Nullable(Float64),is_deleted UInt8,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree ORDER BY (user_id,started_at)",
      "v_daily_metrics (user_id UUID,date Date,steps Nullable(Float64),exercise_minutes Nullable(Float64)) ENGINE=Memory",
      "activity_vo2max_estimate (user_id UUID,started_at DateTime64(6),vo2max Nullable(Float64),is_deleted UInt8) ENGINE=ReplacingMergeTree ORDER BY (user_id,started_at)",
      "daily_body_measurement (user_id UUID,date Date,weight_kg Nullable(Float64),body_fat_pct Nullable(Float64),recorded_at DateTime64(6),refresh_version UInt64,measurement_id UUID,is_deleted UInt8,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree ORDER BY (user_id,date)",
      "weekly_healthspan (user_id UUID,week_start Date,refreshed_at DateTime64(9)) ENGINE=ReplacingMergeTree ORDER BY (user_id,week_start)",
    ]) await client.command({query:`CREATE TABLE ${database}.${definition}`});
    await client.command({query:`CREATE VIEW ${database}.deduped_activities AS SELECT * FROM ${database}.activity_summary_rows FINAL`});
    await client.command({query:`INSERT INTO ${database}.user_profile_current (id,max_hr,resting_hr) VALUES ('${user}',NULL,50)`});
    for(const id of [supported,unavailable]) {
      await client.command({query:`INSERT INTO ${database}.activity_summary_rows (activity_id,user_id,canonical_type,started_at,ended_at,is_deleted) VALUES ('${id}','${user}','cycling','2026-01-01 12:00:00','2026-01-01 12:10:00',0)`});
      await client.command({query:`INSERT INTO ${database}.activity_sensor_sample SELECT toUUID('${user}'),toUUID('${id}'),toDateTime64('2026-01-01 12:00:00',6)+toIntervalSecond(number*5),'power',220.0,0 FROM numbers(60)`});
    }
    await client.command({query:`INSERT INTO ${database}.cycling_activity_power_metrics (user_id,activity_id,eftp) VALUES ('${user}','${supported}',240)`});
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
    await client.command({query:`INSERT INTO ${database}.weekly_healthspan SELECT toUUID('${user}'),toMonday(today()+toIntervalWeek(1)),now64(9)-toIntervalDay(1)`});
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
  it("refreshes a persisted old week when an activity moves to another historical week",async()=>{
    const movedUser=randomUUID();const movedActivity=randomUUID();
    await client.command({query:`INSERT INTO ${database}.weekly_healthspan SELECT toUUID('${movedUser}'),toDate('2000-01-03'),now64(9)-toIntervalDay(1) UNION ALL SELECT toUUID('${movedUser}'),toMonday(today()+toIntervalWeek(1)),now64(9)-toIntervalDay(1)`});
    await client.command({query:`INSERT INTO ${database}.healthspan_activity_zone_minutes VALUES ('${movedActivity}','${movedUser}','2000-01-03 12:00:00','2000-01-03 12:10:00',0,5,0,1,now64(9)-toIntervalDay(2))`});
    await client.command({query:`INSERT INTO ${database}.healthspan_activity_zone_minutes VALUES ('${movedActivity}','${movedUser}','2001-01-01 12:00:00','2001-01-01 12:10:00',0,5,0,2,now64(9))`});
    await client.command({query:`OPTIMIZE TABLE ${database}.healthspan_activity_zone_minutes FINAL`});
    const result=await client.query({query:render("weekly_healthspan.sql",true)+"\nSETTINGS join_use_nulls=1",format:"JSONEachRow"});
    const rows=await result.json<Record<string,unknown>>();
    expect(rows.find(row=>row.user_id===movedUser&&row.week_start==="2000-01-03")?.weekly_high_intensity_min).toBeNull();
    expect(rows.find(row=>row.user_id===movedUser&&row.week_start==="2001-01-01")?.weekly_high_intensity_min).toBe(5);
  });
  it("rebuilds native sample windows only for changed activity inputs",async()=>{
    const before=await client.query({query:render("healthspan_activity_zone_minutes.sql",true)+"\nSETTINGS join_use_nulls=1",format:"JSONEachRow"});
    const unchanged=await before.json<Record<string,unknown>>();
    expect(unchanged.some(row=>row.activity_id===supported||row.activity_id===unavailable)).toBe(false);
    await client.command({query:`ALTER TABLE ${database}.activity_summary_rows UPDATE refreshed_at=now64(9)+toIntervalSecond(1) WHERE activity_id=toUUID('${supported}') SETTINGS mutations_sync=1`});
    const after=await client.query({query:render("healthspan_activity_zone_minutes.sql",true)+"\nSETTINGS join_use_nulls=1",format:"JSONEachRow"});
    const changed=await after.json<Record<string,unknown>>();
    expect(changed.find(row=>row.activity_id===supported)?.high_intensity_minutes).toBe(5);
    expect(changed.some(row=>row.activity_id===unavailable)).toBe(false);
  });
  it("invalidates only the affected user's windows when threshold, profile, or resting evidence changes",async()=>{
    const changedUser=randomUUID();const changedActivity=randomUUID();
    await client.command({query:`INSERT INTO ${database}.activity_summary_rows (activity_id,user_id,canonical_type,started_at,ended_at,is_deleted) VALUES ('${changedActivity}','${changedUser}','cycling','2026-01-02 12:00:00','2026-01-02 12:10:00',0)`});
    await client.command({query:`INSERT INTO ${database}.user_profile_current (id,max_hr,resting_hr) VALUES ('${changedUser}',180,50)`});
    await client.command({query:`INSERT INTO ${database}.cycling_activity_power_metrics (user_id,activity_id,eftp) VALUES ('${changedUser}','${changedActivity}',300)`});
    await client.command({query:`INSERT INTO ${database}.activity_sensor_sample SELECT toUUID('${changedUser}'),toUUID('${changedActivity}'),toDateTime64('2026-01-02 12:00:00',6)+toIntervalSecond(number*5),'power',220.0,0 FROM numbers(60)`});
    const save=()=>client.command({query:`INSERT INTO ${database}.healthspan_activity_zone_minutes SELECT * FROM (${render("healthspan_activity_zone_minutes.sql",true)}) WHERE user_id=toUUID('${changedUser}') SETTINGS join_use_nulls=1`});
    const changed=async()=>{
      const result=await client.query({query:render("healthspan_activity_zone_minutes.sql",true)+"\nSETTINGS join_use_nulls=1",format:"JSONEachRow"});
      return (await result.json<Record<string,unknown>>()).filter(row=>row.user_id===changedUser);
    };
    await save();
    expect(await changed()).toEqual([]);
    await client.command({query:`ALTER TABLE ${database}.cycling_activity_power_metrics UPDATE eftp=240,refreshed_at=now64(9) WHERE activity_id=toUUID('${changedActivity}') SETTINGS mutations_sync=1`});
    expect(await changed()).toEqual([expect.objectContaining({activity_id:changedActivity,high_intensity_minutes:5})]);
    await save();
    await client.command({query:`TRUNCATE TABLE ${database}.user_profile_current`});
    await client.command({query:`INSERT INTO ${database}.user_profile_current (id,max_hr,resting_hr) VALUES ('${changedUser}',180,51)`});
    expect(await changed()).toHaveLength(1);
    await save();
    await client.command({query:`INSERT INTO ${database}.resting_heart_rate_sleep_window (user_id,ended_at,resting_hr,is_deleted) VALUES ('${changedUser}','2026-01-01 07:00:00',49,0)`});
    expect(await changed()).toHaveLength(1);
    await save();
    expect(await changed()).toEqual([]);
  });
  it("keeps observed zero zone minutes distinct from unknown channels under nullable empty aggregates",async()=>{
    const observedUser=randomUUID();
    const lowHr=randomUUID();const highHr=randomUUID();const zeroPower=randomUUID();const noSamples=randomUUID();
    await client.command({query:`INSERT INTO ${database}.user_profile_current (id,max_hr,resting_hr) VALUES ('${observedUser}',200,60)`});
    for(const id of [lowHr,highHr,zeroPower,noSamples]) await client.command({query:`INSERT INTO ${database}.activity_summary_rows (activity_id,user_id,canonical_type,started_at,ended_at,is_deleted) VALUES ('${id}','${observedUser}','cycling','2026-01-03 12:00:00','2026-01-03 12:10:00',0)`});
    await client.command({query:`INSERT INTO ${database}.cycling_activity_power_metrics (user_id,activity_id,eftp) VALUES ('${observedUser}','${zeroPower}',250),('${observedUser}','${noSamples}',250)`});
    for(const [id,channel,value] of [[lowHr,'heart_rate',150],[highHr,'heart_rate',190],[zeroPower,'power',0]] as const) await client.command({query:`INSERT INTO ${database}.activity_sensor_sample SELECT toUUID('${observedUser}'),toUUID('${id}'),toDateTime64('2026-01-03 12:00:00',6)+toIntervalSecond(number),'${channel}',${value},0 FROM numbers(301)`});
    const result=await client.query({query:render("healthspan_activity_zone_minutes.sql",false)+"\nSETTINGS join_use_nulls=1,aggregate_functions_null_for_empty=1",format:"JSONEachRow"});
    const rows=await result.json<Record<string,unknown>>();
    expect(rows.find(row=>row.activity_id===lowHr)).toMatchObject({aerobic_minutes:301/60,high_intensity_minutes:0});
    expect(rows.find(row=>row.activity_id===highHr)).toMatchObject({aerobic_minutes:0,high_intensity_minutes:301/60});
    expect(rows.find(row=>row.activity_id===zeroPower)).toMatchObject({aerobic_minutes:null,high_intensity_minutes:0});
    expect(rows.find(row=>row.activity_id===noSamples)).toMatchObject({aerobic_minutes:null,high_intensity_minutes:null});
  });
});
