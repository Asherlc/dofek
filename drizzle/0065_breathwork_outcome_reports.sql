ALTER TABLE fitness.breathwork_session
ADD COLUMN stress_before bigint,
ADD COLUMN stress_after bigint,
ADD COLUMN dizziness_after boolean,
ADD COLUMN perceived_effect text,
ADD CONSTRAINT breathwork_session_stress_before_range
CHECK (stress_before IS NULL OR stress_before BETWEEN 0 AND 10) NOT VALID,
ADD CONSTRAINT breathwork_session_stress_after_range
CHECK (stress_after IS NULL OR stress_after BETWEEN 0 AND 10) NOT VALID,
ADD CONSTRAINT breathwork_session_perceived_effect_valid
CHECK (perceived_effect IS NULL OR perceived_effect IN ('better', 'same', 'worse')) NOT VALID;

ALTER TABLE fitness.breathwork_session
VALIDATE CONSTRAINT breathwork_session_stress_before_range;

ALTER TABLE fitness.breathwork_session
VALIDATE CONSTRAINT breathwork_session_stress_after_range;

ALTER TABLE fitness.breathwork_session
VALIDATE CONSTRAINT breathwork_session_perceived_effect_valid;
