# Roadmap

## Phase 1 — Foundation
- Repository structure
- Catalog schema
- Duplicate strategy
- Drive/storage contract
- Viewer requirements

## Phase 2 — Ingestion
- Canonical URL normalization
- SHA-256 hashing
- EXIF/XMP/IPTC and media metadata extraction
- Google Drive upload
- Thumbnail generation
- Catalog upsert
- Duplicate reporting

## Phase 3 — Extension integration
- Submit extracted candidates to ingestion API
- Progress and per-item status
- Retry failed items without duplicating successful items

## Phase 4 — Viewer
- Gallery
- 4 display densities
- Search
- Faceted filters
- Sorting
- Asset details

## Phase 5 — Operations
- Authentication/authorization
- Backups
- Re-indexing
- Export CSV/XLSX
- Integrity audit between catalog and Drive
