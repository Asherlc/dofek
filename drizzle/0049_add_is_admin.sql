-- Add is_admin flag to user_profile
ALTER TABLE fitness.user_profile ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- Set admin flag for the primary user
UPDATE fitness.user_profile SET is_admin = true WHERE email = 'asherlc@asherlc.com';
