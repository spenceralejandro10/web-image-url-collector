-- Provider-neutral PostgreSQL catalog schema.
create table if not exists assets (
  id uuid primary key,
  human_id varchar(32) unique not null,
  sha256 char(64) unique not null,
  media_type varchar(16) not null,
  format varchar(16),
  mime_type varchar(128),
  original_filename text,
  display_name text,
  byte_size bigint,
  width integer,
  height integer,
  duration_ms bigint,
  drive_file_id text unique,
  drive_thumbnail_file_id text,
  captured_at timestamptz,
  camera_make text,
  camera_model text,
  software text,
  iso integer,
  exposure_time text,
  aperture numeric,
  focal_length numeric,
  latitude double precision,
  longitude double precision,
  city text,
  country text,
  description text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists asset_sources (
  id bigserial primary key,
  asset_id uuid not null references assets(id) on delete cascade,
  source_url text not null,
  canonical_url text,
  pin_url text,
  source_site text,
  title text,
  alt_text text,
  context_text text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(asset_id, source_url)
);

create index if not exists idx_assets_media_type on assets(media_type);
create index if not exists idx_assets_format on assets(format);
create index if not exists idx_assets_country_city on assets(country, city);
create index if not exists idx_assets_captured_at on assets(captured_at);
create index if not exists idx_assets_camera on assets(camera_make, camera_model);
create index if not exists idx_sources_canonical_url on asset_sources(canonical_url);
