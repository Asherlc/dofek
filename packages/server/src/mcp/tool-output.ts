import { z } from "zod";

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();
const rangeSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  timezone: z.string(),
});
const jsonResult = <T extends z.ZodType>(result: T) => z.object({ result });

const dailyMetricsSchema = z
  .object({
    date: z.string(),
    user_id: z.string(),
    hrv: nullableNumber,
    spo2_avg: nullableNumber,
    respiratory_rate_avg: nullableNumber,
    skin_temp_c: nullableNumber,
    steps: nullableNumber,
    distance_km: nullableNumber,
    flights_climbed: nullableNumber,
    exercise_minutes: nullableNumber,
    stand_hours: nullableNumber,
    walking_speed: nullableNumber,
    source_providers: z.array(z.string()),
  })
  .partial();

export const dailyHealthSummaryOutputSchema = jsonResult(dailyMetricsSchema.nullable());

const healthTrendPointSchema = z.object({ key: z.string(), value: nullableNumber });
const healthTrendMetricSchema = z
  .object({
    metric: z.string(),
    label: z.string(),
    unit: z.string(),
    points: z.array(healthTrendPointSchema),
    note: nullableString,
    summary: z.object({ average: nullableNumber, min: nullableNumber, max: nullableNumber }),
    coverage: z.object({
      observed_days: z.number(),
      missing_days: z.array(z.string()),
      missing_days_truncated_count: z.number(),
    }),
  })
  .partial();
export const healthTrendsOutputSchema = jsonResult(
  z
    .object({
      range: z.object({ start_date: z.string(), end_date: z.string(), timezone: z.string() }),
      requested_metrics: z.array(z.string()),
      series: z.array(healthTrendMetricSchema),
      diagnostics: z.object({
        metrics_with_no_data: z.array(z.string()),
        range_clamped: z.boolean(),
        earliest_available: nullableString,
      }),
    })
    .partial(),
);

export const dataCoverageOutputSchema = jsonResult(
  z.array(
    z.object({
      metric: z.string(),
      first_observed: nullableString,
      last_observed: nullableString,
      total_days_observed: z.number().int().nonnegative(),
      source_providers: z.array(z.string()),
    }),
  ),
);

const localTimeContextSchema = z
  .object({
    timezone: nullableString,
    startUtcOffsetMinutes: z.number().nullable(),
    endUtcOffsetMinutes: z.number().nullable(),
    source: nullableString,
  })
  .partial();
export const sleepSummaryOutputSchema = jsonResult(
  z.array(
    z
      .object({
        date: z.string(),
        staging_available: z.boolean(),
        total_duration_minutes: nullableNumber,
        sleep_efficiency_pct: nullableNumber,
        time_in_bed_minutes: nullableNumber,
        onset_time: nullableString,
        wake_time: nullableString,
        local_time_context: localTimeContextSchema,
        stages: z.object({
          rem_minutes: nullableNumber,
          sws_minutes: nullableNumber,
          light_minutes: nullableNumber,
          awake_minutes: nullableNumber,
        }),
        sleep_consistency_pct: z.null(),
        respiratory_rate_avg: nullableNumber,
        source_provider: z.string(),
      })
      .partial(),
  ),
);

const activityListItemSchema = z
  .object({
    id: z.string(),
    canonical_type: z.string(),
    name: nullableString,
    started_at: z.string(),
    ended_at: nullableString,
    location: z.record(z.string(), z.json()).nullable(),
  })
  .partial()
  .passthrough();
export const searchActivitiesOutputSchema = jsonResult(
  z.object({ items: z.array(activityListItemSchema), totalCount: z.number().int().nonnegative() }),
);

const activityPowerSummarySchema = z
  .object({ avg: nullableNumber, min: nullableNumber, max: nullableNumber })
  .partial();
const activitySummaryEntrySchema = z
  .object({
    canonical_type: z.string().optional(),
    week: z.string().optional(),
    modality: nullableString.optional(),
    purpose: nullableString.optional(),
    count: z.number().int().nonnegative(),
    total_duration_minutes: z.number(),
    avg_duration_minutes: nullableNumber,
    avg_hr: nullableNumber,
    max_hr_peak: nullableNumber,
    power_by_modality: z.object({
      indoor: activityPowerSummarySchema.nullable(),
      outdoor: activityPowerSummarySchema.nullable(),
      unknown: activityPowerSummarySchema.nullable(),
    }),
    total_elevation_gain_m: nullableNumber,
    avg_elevation_gain_m: nullableNumber,
  })
  .partial();
export const activitySummaryOutputSchema = jsonResult(
  z.object({ unclassified_pct: z.number(), summaries: z.array(activitySummaryEntrySchema) }),
);

export const fingerLoadingOutputSchema = jsonResult(
  z.array(
    z
      .object({
        activity_id: z.string(),
        bodyweight_kg: nullableNumber,
        edge_size_mm: nullableNumber,
        effective_load_kg: nullableNumber,
        effective_load_formula: z.literal("bodyweight_kg + external_load_kg"),
        exercise: z.string(),
        external_load_kg: nullableNumber,
        grip_position: nullableString,
        hold_duration_seconds: z.number(),
        laterality: nullableString,
        notes: nullableString,
        rest_interval_seconds: nullableNumber,
        rpe: nullableNumber,
        set_count: z.number().int(),
        started_at: z.string(),
        total_time_under_tension_seconds: z.number(),
      })
      .partial(),
  ),
);

export const nutritionSummaryOutputSchema = jsonResult(
  z.array(
    z.object({
      date: z.string(),
      total_calories: nullableNumber,
      protein_g: nullableNumber,
      carbs_g: nullableNumber,
      fat_g: nullableNumber,
      fiber_g: nullableNumber,
      meal_count: z.number(),
      resolution_status: z.enum(["available", "source_conflict"]),
      resolution_message: z.string(),
      source_provider: nullableString,
      source_providers: z.array(z.string()),
      contributing_providers: z.array(z.string()),
      excluded_providers: z.array(z.string()),
    }),
  ),
);

export const bodyMetricsOutputSchema = jsonResult(
  z.array(
    z.object({
      date: z.string(),
      weight_kg: nullableNumber,
      body_fat_pct: nullableNumber,
      lean_mass_kg: nullableNumber,
      bmi: nullableNumber,
      source_provider_by_metric: z.object({
        weight_kg: nullableString,
        body_fat_pct: nullableString,
        bmi: nullableString,
      }),
      sources: z.array(
        z.object({
          source_provider: z.string(),
          recorded_at: z.string(),
          weight_kg: nullableNumber,
          body_fat_pct: nullableNumber,
          bmi: nullableNumber,
        }),
      ),
      coverage: z.object({ source_count: z.number().int().nonnegative() }),
    }),
  ),
);

export const subjectiveTimelineOutputSchema = jsonResult(
  z.object({
    checkIns: z.array(
      z.object({
        date: z.string(),
        logged: z.boolean(),
        symptoms: z.array(
          z.object({
            id: z.string(),
            body_region_id: z.string(),
            kind: z.string(),
            score: z.number(),
          }),
        ),
      }),
    ),
    injuries: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["injury", "niggle"]),
        body_region_id: z.string(),
        onset_date: z.string(),
        resolved_date: nullableString,
        severity: nullableNumber,
        description: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
  }),
);

const syncHealthSchema = z.object({
  last_success: nullableString,
  last_attempt: nullableString,
  last_error: nullableString,
  consecutive_failures: z.number().int().nonnegative(),
  expected_sync_interval_minutes: z.number(),
  stale: z.boolean(),
});
export const providersOutputSchema = jsonResult(
  z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      authType: z.string(),
      authorized: z.boolean(),
      lastSyncedAt: nullableString,
      importOnly: z.boolean(),
      needsReauth: z.boolean(),
      sync_health: syncHealthSchema.nullable(),
    }),
  ),
);

export const providerSyncOutputSchema = jsonResult(
  z.object({
    providerId: z.string(),
    jobId: z.string(),
    queueName: z.string(),
    status: z.literal("queued"),
  }),
);

const streamChannelSchema = z.enum([
  "power",
  "heart_rate",
  "cadence",
  "altitude",
  "speed",
  "position",
]);
export const activityStreamsOutputSchema = jsonResult(
  z.object({
    channels: z.array(streamChannelSchema),
    points: z.array(
      z.object({
        recorded_at: z.string(),
        power: nullableNumber.optional(),
        heart_rate: nullableNumber.optional(),
        cadence: nullableNumber.optional(),
        altitude: nullableNumber.optional(),
        speed: nullableNumber.optional(),
        latitude: nullableNumber.optional(),
        longitude: nullableNumber.optional(),
      }),
    ),
  }),
);

const climbingAttemptSchema = z
  .object({
    attemptIndex: z.number().int().positive(),
    failureReason: nullableString,
    notes: nullableString,
    outcome: z.enum(["sent", "failed"]),
  })
  .partial();
const climbingEntrySchema = z
  .object({
    id: z.string(),
    discipline: z.enum(["boulder", "lead", "top_rope", "route"]),
    grade: z.string(),
    grade_system: z.string(),
    sent: z.boolean(),
    attempt_count: z.number().int().positive(),
    attempts: z.array(climbingAttemptSchema),
    ascent_type: nullableString,
    hold_type: nullableString,
    route_name: nullableString,
    location_name: nullableString,
    source_name: z.string(),
    wall_angle_degrees: nullableNumber,
  })
  .partial();
export const climbingSessionsOutputSchema = jsonResult(
  z.object({
    sessions: z.array(
      z
        .object({
          activity_id: z.string(),
          started_at: z.string(),
          duration_minutes: nullableNumber,
          avg_hr: nullableNumber,
          name: nullableString,
          gym_vs_crag: z.null(),
          location: nullableString,
          total_vertical_m: z.null(),
          climbs: z.array(climbingEntrySchema),
        })
        .partial(),
    ),
    aggregates: z.object({
      grade_distribution: z.array(
        z
          .object({
            discipline: z.enum(["boulder", "lead", "top_rope", "route"]),
            grade: z.string(),
            grade_system: z.string(),
            attempts: z.number(),
            sends: z.number(),
          })
          .partial(),
      ),
      send_rate: nullableNumber,
      max_grade_by_discipline: z.object({ boulder: nullableString, route: nullableString }),
      volume: z.object({
        climbs: z.number(),
        attempts: z.number(),
        sends: z.number(),
        total_vertical_m: z.null(),
      }),
    }),
  }),
);

const strengthSetSchema = z
  .object({
    setIndex: z.number().int(),
    setType: nullableString,
    weightKg: nullableNumber,
    reps: nullableNumber,
    durationSeconds: nullableNumber,
    rpe: nullableNumber,
    notes: nullableString,
  })
  .partial();
const strengthExerciseSchema = z
  .object({
    exerciseIndex: z.number().int(),
    exerciseName: z.string(),
    equipment: nullableString,
    muscleGroups: z.array(z.string()).nullable(),
    exerciseType: nullableString,
    sets: z.array(strengthSetSchema),
  })
  .partial();
export const strengthSessionsOutputSchema = jsonResult(
  z.object({
    sessions: z.array(
      z
        .object({
          activity_id: z.string(),
          started_at: z.string(),
          duration_minutes: nullableNumber,
          avg_hr: nullableNumber,
          name: nullableString,
          volume_load_kg: z.number(),
          exercises: z.array(strengthExerciseSchema),
        })
        .partial(),
    ),
    aggregates: z.object({
      volume_load_kg: z.number(),
      by_muscle_group: z.array(z.object({ muscle_group: z.string(), volume_load_kg: z.number() })),
    }),
  }),
);

const cyclingEffortsSchema = z.object({
  "5s": nullableNumber,
  "1m": nullableNumber,
  "5m": nullableNumber,
  "20m": nullableNumber,
});
export const cyclingPerformanceOutputSchema = jsonResult(
  z.object({
    range: rangeSchema,
    activities: z.array(
      z.object({
        activity_id: z.string(),
        date: z.string(),
        name: nullableString,
        modality: nullableString,
        duration_minutes: z.number(),
        average_power_watts: nullableNumber,
        normalized_power_watts: nullableNumber,
        estimated_ftp_watts: nullableNumber,
        estimated_ftp_source: nullableString,
        intensity_factor: nullableNumber,
        elevation_gain_m: nullableNumber,
        best_efforts_watts: cyclingEffortsSchema,
      }),
    ),
    rolling_90_day_best: z.object({
      "5s": z.object({ activity_id: z.string(), date: z.string(), watts: z.number() }).nullable(),
      "1m": z.object({ activity_id: z.string(), date: z.string(), watts: z.number() }).nullable(),
      "5m": z.object({ activity_id: z.string(), date: z.string(), watts: z.number() }).nullable(),
      "20m": z.object({ activity_id: z.string(), date: z.string(), watts: z.number() }).nullable(),
    }),
    summary: z.object({
      power_coverage: z.object({
        activities_with_power: z.number(),
        activities_total: z.number(),
        pct: z.number(),
      }),
      elevation_gain: z.object({
        total_elevation_gain_m: nullableNumber,
        avg_elevation_gain_m: nullableNumber,
        coverage: z.object({
          activities_with_elevation: z.number(),
          activities_total: z.number(),
          pct: z.number(),
        }),
      }),
    }),
  }),
);

const activityDetailSchema = z.object({ id: z.string() }).passthrough();
const activityDetailsClimbSchema = z
  .object({ id: z.string(), grade: z.string(), routeName: nullableString })
  .partial()
  .passthrough();
const activityDetailsExerciseSchema = z
  .object({ exerciseName: z.string(), muscleGroups: z.array(z.string()).nullable() })
  .partial()
  .passthrough();
const activityFingerLoadingSchema = z
  .object({ exercise: z.string(), effectiveLoadKg: nullableNumber })
  .partial()
  .passthrough();
export const activityDetailsOutputSchema = jsonResult(
  z.object({
    activity: activityDetailSchema,
    climbing_entries: z.array(activityDetailsClimbSchema),
    finger_loading: z.array(activityFingerLoadingSchema),
    strength_exercises: z.array(activityDetailsExerciseSchema),
  }),
);

const supplementSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    amount: z.number().positive().optional(),
    unit: z.string().optional(),
    form: z.string().optional(),
    description: z.string().optional(),
    meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  })
  .catchall(z.number());
export const supplementsOutputSchema = jsonResult(z.array(supplementSchema));

export const trainingLoadOutputSchema = jsonResult(
  z.object({
    range: rangeSchema,
    rows: z.array(
      z.object({
        date: z.string(),
        daily_load: z.number(),
        acute_load_7d: z.number(),
        chronic_load_28d: z.number(),
        workload_ratio: nullableNumber,
        coverage: z.object({
          acute_window_days: z.number().int(),
          chronic_window_days: z.number().int(),
        }),
      }),
    ),
  }),
);

export const mcpOutputSchemas = {
  activitySummary: activitySummaryOutputSchema,
  bodyMetrics: bodyMetricsOutputSchema,
  dailyHealthSummary: dailyHealthSummaryOutputSchema,
  dataCoverage: dataCoverageOutputSchema,
  fingerLoading: fingerLoadingOutputSchema,
  healthTrends: healthTrendsOutputSchema,
  nutritionSummary: nutritionSummaryOutputSchema,
  providerSync: providerSyncOutputSchema,
  providers: providersOutputSchema,
  searchActivities: searchActivitiesOutputSchema,
  sleepSummary: sleepSummaryOutputSchema,
  subjectiveTimeline: subjectiveTimelineOutputSchema,
};
