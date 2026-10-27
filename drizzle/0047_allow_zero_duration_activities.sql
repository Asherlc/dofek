-- Activities cannot end before they start, but zero-duration activities are
-- valid when provider timestamps are second-resolution or a workout is started
-- and stopped immediately.
ALTER TABLE fitness.activity
DROP CONSTRAINT activity_ended_after_started_chk;

ALTER TABLE fitness.activity
ADD CONSTRAINT activity_ended_after_started_chk
CHECK (ended_at IS NULL OR ended_at >= started_at) NOT VALID;

ALTER TABLE fitness.activity
VALIDATE CONSTRAINT activity_ended_after_started_chk;
