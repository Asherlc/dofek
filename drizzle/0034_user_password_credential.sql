CREATE TABLE fitness.user_password_credential (
  user_id uuid NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT user_password_credential_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_password_credential_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  CONSTRAINT user_password_credential_email_key UNIQUE (email)
);
