CREATE TABLE fitness.activity_device_observation (
  activity_id uuid NOT NULL REFERENCES fitness.activity (id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  message_type text NOT NULL,
  raw jsonb NOT NULL,
  CONSTRAINT activity_device_observation_activity_id_sequence_pk PRIMARY KEY (activity_id, sequence),
  CONSTRAINT activity_device_observation_sequence_nonnegative CHECK (sequence >= 0),
  CONSTRAINT activity_device_observation_message_type CHECK (message_type IN ('file_id', 'device_info'))
);
