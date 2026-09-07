ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'font' AFTER 'v_scale';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'french' AFTER 'yds';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'uiaa' AFTER 'french';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'ewbank' AFTER 'uiaa';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'saxon' AFTER 'ewbank';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'norwegian' AFTER 'saxon';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'brazilian_crux' AFTER 'norwegian';
