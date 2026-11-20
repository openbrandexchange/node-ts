-- Portal appearance (node-admin.yaml, branding images): pictures for the login page and the retailer
-- start page. The file is a content-addressed blob; an id is never reused (a new upload is a new id),
-- so the public address of an image can be cached for a year.
CREATE TABLE IF NOT EXISTS branding_images (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS branding_images_sha ON branding_images(sha256);
