create extension if not exists pgcrypto;

create sequence if not exists public.wmc_collection_seq start 1;
create sequence if not exists public.wmc_asset_seq start 1;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  google_sub text unique not null,
  email text not null,
  display_name text,
  picture_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.drive_accounts (
  user_id uuid primary key references public.users(id) on delete cascade,
  refresh_token_enc text not null,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  token_hash char(64) primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.device_auth (
  device_id uuid primary key,
  secret_hash char(64) not null,
  user_id uuid references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_drive_folders (
  user_id uuid primary key references public.users(id) on delete cascade,
  root_folder_id text,
  jpg_folder_id text,
  png_folder_id text,
  gif_folder_id text,
  webp_folder_id text,
  video_folder_id text,
  thumbnails_folder_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.collections (
  id bigint primary key,
  public_id varchar(24) unique not null,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_drive_folders (
  collection_id bigint not null references public.collections(id) on delete cascade,
  category varchar(16) not null,
  drive_folder_id text not null,
  primary key(collection_id, category)
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  asset_no bigint unique not null,
  human_id varchar(32) unique not null,
  user_id uuid not null references public.users(id) on delete cascade,
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
  drive_present boolean not null default true,
  drive_missing_since timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, sha256)
);

create table if not exists public.asset_sources (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
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

create table if not exists public.collection_assets (
  collection_id bigint not null references public.collections(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key(collection_id, asset_id)
);

create table if not exists public.backend_auth (
  key_hash char(64) primary key,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.wmc_assign_collection_identity()
returns trigger
language plpgsql
as $$
begin
  if new.id is null then
    new.id := nextval('public.wmc_collection_seq');
  end if;
  if new.public_id is null or btrim(new.public_id) = '' then
    new.public_id := 'WMC-' || lpad(new.id::text, 6, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wmc_collection_identity on public.collections;
create trigger trg_wmc_collection_identity
before insert on public.collections
for each row execute function public.wmc_assign_collection_identity();

create or replace function public.wmc_assign_asset_identity()
returns trigger
language plpgsql
as $$
begin
  if new.asset_no is null then
    new.asset_no := nextval('public.wmc_asset_seq');
  end if;
  if new.human_id is null or btrim(new.human_id) = '' then
    new.human_id :=
      case when lower(coalesce(new.media_type,'')) = 'video' then 'VID-' else 'IMG-' end
      || lpad(new.asset_no::text, 2, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wmc_asset_identity on public.assets;
create trigger trg_wmc_asset_identity
before insert on public.assets
for each row execute function public.wmc_assign_asset_identity();

create index if not exists idx_sessions_user on public.sessions(user_id);
create index if not exists idx_sessions_expiry on public.sessions(expires_at);
create index if not exists idx_device_auth_expiry on public.device_auth(expires_at);
create index if not exists idx_collections_user on public.collections(user_id, created_at desc);
create index if not exists idx_assets_user_type on public.assets(user_id, media_type);
create index if not exists idx_assets_user_format on public.assets(user_id, format);
create index if not exists idx_assets_user_capture on public.assets(user_id, captured_at);
create index if not exists idx_assets_user_drive_present on public.assets(user_id, drive_present);
create index if not exists idx_sources_user_canonical on public.asset_sources(user_id, canonical_url);

alter table public.users enable row level security;
alter table public.drive_accounts enable row level security;
alter table public.sessions enable row level security;
alter table public.device_auth enable row level security;
alter table public.user_drive_folders enable row level security;
alter table public.collections enable row level security;
alter table public.collection_drive_folders enable row level security;
alter table public.assets enable row level security;
alter table public.asset_sources enable row level security;
alter table public.collection_assets enable row level security;
alter table public.backend_auth enable row level security;
