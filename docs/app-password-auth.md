# App Password Auth

## Password Recovery

Email/password users can request a password reset from the login screen. Reset links are sent through Brevo SMTP, expire after 1 hour, and are single-use. The server stores only a SHA-256 hash of each reset token in `fitness.password_reset_token`.

Authenticated users can set or change their password from Settings. OAuth-only users can set a password if their profile has an email address; users with an existing password must provide the current password.
