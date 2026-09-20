# Media Library Architecture

## Responsibilities
- **Chrome extension**: discovers media and source context, then submits candidates to the ingestion API.
- **Ingestion API**: canonicalizes URLs, detects duplicates, downloads once, computes SHA-256, extracts metadata, uploads originals/thumbnails to Google Drive, and writes catalog records.
- **Google Drive**: stores heavy originals and generated thumbnails. It is not the database.
- **Catalog database**: stores searchable metadata, identifiers, Drive file IDs, hashes, source URLs, and classifications.
- **Web viewer**: e-commerce-style gallery with search, facets and small/medium/large/x-large card density.
- **GitHub**: source code only. Media and credentials are excluded.

## Ingestion pipeline
candidate -> canonical URL check -> download/stream -> SHA-256 -> content hash check -> metadata extraction -> stable asset ID -> Drive upload -> thumbnail -> catalog upsert

## Duplicate policy
URL matching is only the first inexpensive check. The authoritative duplicate key is the content SHA-256.
1. Normalize the source URL and check it against previously seen URLs.
2. If unseen, obtain the media bytes and calculate SHA-256.
3. If that SHA-256 already exists, do not upload a second original. Attach the new source URL/Pin to the existing asset.
4. If the hash is new, create the asset and upload it.
This catches the same image reached through different Pinterest URLs, sizes or query strings.

## Viewer facets
Media type, format, country, city, capture year/date, camera make/model, dimensions, source, tags, metadata completeness and duplicate status.

## Storage
Google Drive folders are logical storage targets (Images/JPG, PNG, GIF, WEBP, Video, Thumbnails). The catalog stores Drive file IDs rather than relying on mutable share URLs.
