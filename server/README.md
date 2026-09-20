# Ingestion API

This service will receive candidates from the Chrome extension and own the reliable ingestion transaction.

Planned endpoints:
- POST /api/ingest/check — inexpensive canonical-URL precheck.
- POST /api/ingest — download/stream, hash, deduplicate, extract metadata, upload to Drive and catalog.
- GET /api/assets — paginated search and facet filters.
- GET /api/assets/:id — asset details and sources.
- GET /api/facets — counts for format, media type, location, date and camera.

Secrets (Google OAuth/service credentials and database credentials) belong in environment variables and must never be committed.
