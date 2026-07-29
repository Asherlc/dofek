ALTER TABLE fitness.breathwork_session
ADD COLUMN stress_before smallint,
ADD COLUMN stress_after smallint,
ADD COLUMN dizziness_after boolean,
ADD COLUMN perceived_effect text,
ADD CONSTRAINT breathwork_session_stress_before_range
CHECK (stress_before IS NULL OR stress_before BETWEEN 0 AND 10),
ADD CONSTRAINT breathwork_session_stress_after_range
CHECK (stress_after IS NULL OR stress_after BETWEEN 0 AND 10),
ADD CONSTRAINT breathwork_session_perceived_effect_valid
CHECK (perceived_effect IS NULL OR perceived_effect IN ('better', 'same', 'worse'));
