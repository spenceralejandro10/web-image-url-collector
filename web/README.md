# Media Viewer

Planned responsive catalog UI:
- Grid density: small, medium, large and extra-large.
- Search by ID, filename, title, description and tags.
- Facets: image/video, JPG/JPEG, PNG, GIF, WEBP, video format, country, city, capture date/year, camera, dimensions and source.
- Asset detail view with original metadata, Pinterest/source references and Drive-backed original.
- Sorting by newest ingested, capture date, name, size and dimensions.
- Pagination/virtualization so tens of thousands of records remain responsive.

The viewer consumes the catalog API. It does not enumerate Google Drive as its database.
