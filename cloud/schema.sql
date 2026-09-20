create extension if not exists pgcrypto;

create sequence if not exists collection_number_seq start 1;
create sequence if not exists asset_number_seq start 1;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  google_sub text unique not null,
  email text not null,
  display_name text,
  picture_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists drive_accounts (
  user_id uuid primary key references users(id) on delete cascade,
  refresh_token_enc text not null,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash char(64) primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_user on sessions(user_id);
create index if not exists idx_sessions_expiry on sessions(expires_at);

create table if not exists device_auth (
  device_id uuid primary key,
  secret_hash char(64) not null,
  user_id uuid references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_device_auth_expiry on device_auth(expires_at);

create table if not exists user_drive_folders (
  user_id uuid primary key references users(id) on delete cascade,
  root_folder_id text,
  jpg_folder_id text,
  png_folder_id text,
  gif_folder_id text,
  webp_folder_id text,
  video_folder_id text,
  thumbnails_folder_id text,
  updated_at timestamptz not null default now()
);

create table if not exists collections (
  id bigint primary key,
  public_id varchar(24) unique not null,
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_collections_user on collections(user_id, created_at desc);

create table if not exists collection_drive_folders (
  collection_id bigint not null references collections(id) on delete cascade,
  category varchar(16) not null,
  drive_folder_id text not null,
  primary key(collection_id, category)
);

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  asset_no bigint unique not null,
  human_id varchar(32) unique not null,
  user_id uuid not null references users(id) on delete cascade,
  sha256 char(64) not null,
  media_type varchar(16) not null,
  format varchar(16),
  mime_type varchar(128),
  filename text,
  display_name text,
  byte_size bigint,
  width integer,
  height integer,
  duration_ms bigint,
  drive_file_id text,
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
  updated_at timestamptz not null default now(),
  unique(user_id, sha256)
);
create index if not exists idx_assets_user_type on assets(user_id, media_type);
create index if not exists idx_assets_user_format on assets(user_id, format);
create index if not exists idx_assets_user_capture on assets(user_id, captured_at);

create table if not exists asset_sources (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  source_url text not null,
  canonical_url text,
  source_page text,
  title text,
  alt_text text,
  context_text text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(user_id, source_url)
);
create index if not exists idx_sources_user_canonical on asset_sources(user_id, canonical_url);

create table if not exists collection_assets (
  collection_id bigint not null references collections(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key(collection_id, asset_id)
);
