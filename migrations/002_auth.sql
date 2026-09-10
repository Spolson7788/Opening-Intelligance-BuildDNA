-- Add auth support to users table

ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ALTER COLUMN password_hash DROP DEFAULT;

CREATE INDEX idx_users_email ON users(email);
