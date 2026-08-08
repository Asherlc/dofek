CREATE TABLE fitness.processing_alert_dismissal (
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  dismissed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT processing_alert_dismissal_pkey PRIMARY KEY (user_id, operation_id)
);
