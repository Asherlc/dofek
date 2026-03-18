-- ============================================================
-- Migration 0034: Add DEXA scan tables for BodySpec provider
-- ============================================================
-- Dedicated tables for DEXA body composition scans. Structurally
-- different from scale-based body_measurement (regional breakdowns,
-- bone mineral density, visceral fat, percentiles). Unification
-- with body_measurement for dashboards happens at the query layer.
-- ============================================================

CREATE TABLE fitness.dexa_scan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT NOT NULL REFERENCES fitness.provider(id),
  user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES fitness.user_profile(id),
  external_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  scanner_model TEXT,
  -- Total body composition
  total_fat_mass_kg REAL,
  total_lean_mass_kg REAL,
  total_bone_mass_kg REAL,
  total_mass_kg REAL,
  body_fat_pct REAL,
  android_gynoid_ratio REAL,
  -- Visceral fat
  visceral_fat_mass_kg REAL,
  visceral_fat_volume_cm3 REAL,
  -- Total bone density
  total_bone_mineral_density REAL,  -- g/cm2
  bone_density_t_percentile REAL,   -- vs peak (30yo), 1-99
  bone_density_z_percentile REAL,   -- vs age/sex matched, 1-99
  -- Resting metabolic rate
  resting_metabolic_rate_kcal REAL,  -- primary estimate (ten Haaf 2014)
  resting_metabolic_rate_raw JSONB,  -- all formula estimates (proprietary BodySpec calculations)
  -- Percentiles (proprietary BodySpec reference populations)
  percentiles JSONB,
  -- Patient intake from scan
  height_inches REAL,
  weight_pounds REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX dexa_scan_provider_external_idx ON fitness.dexa_scan (provider_id, external_id);
CREATE INDEX dexa_scan_user_provider_idx ON fitness.dexa_scan (user_id, provider_id);
CREATE INDEX dexa_scan_recorded_at_idx ON fitness.dexa_scan (recorded_at DESC);

--> statement-breakpoint

CREATE TABLE fitness.dexa_scan_region (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES fitness.dexa_scan(id) ON DELETE CASCADE,
  region TEXT NOT NULL,  -- android, gynoid, left_arm, right_arm, left_leg, right_leg, trunk
  -- Body composition
  fat_mass_kg REAL,
  lean_mass_kg REAL,
  bone_mass_kg REAL,
  total_mass_kg REAL,
  tissue_fat_pct REAL,   -- fat % of soft tissue in region
  region_fat_pct REAL,   -- this region's fat as % of total body fat
  -- Bone density
  bone_mineral_density REAL,   -- g/cm2
  bone_area_cm2 REAL,
  bone_mineral_content_g REAL,
  z_score_percentile REAL,     -- age/sex matched, 1-99
  t_score_percentile REAL      -- vs peak (30yo), 1-99
);

CREATE UNIQUE INDEX dexa_scan_region_scan_region_idx ON fitness.dexa_scan_region (scan_id, region);
CREATE INDEX dexa_scan_region_scan_idx ON fitness.dexa_scan_region (scan_id);
