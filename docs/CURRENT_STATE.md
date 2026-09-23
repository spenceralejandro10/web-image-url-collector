# Estado actual del proyecto

## Versión activa
**Spencer Collector Pro 4.2.4**

Fecha: 2026-09-22.

## Flujo vigente

1. Extraer imágenes, GIF, WebP y videos.
2. Seleccionar o descartar contenido.
3. Analizar información y metadatos.
4. Descargar un ZIP local.

Google Drive no forma parte del flujo activo.

## Selector

Al abrir el selector se conserva el ID de la pestaña de origen. Al pulsar **Aplicar selección y cerrar**, la extensión reactiva esa pestaña y cierra el selector.

## GIF

La detección ya no depende solo de URLs terminadas en `.gif`. Se revisan:
- `img/src/srcset`;
- atributos `data-*`;
- recursos observados mediante `performance.getEntriesByType("resource")`;
- meta tags;
- HTML serializado con URLs GIF escapadas;
- parámetros como `format=gif`, `fm=gif` o `type=gif`.

La clasificación final del backend también usa el `Content-Type`, por lo que `image/gif` se guarda como GIF aunque la URL sea ambigua.

## Video

La extensión:
- detecta MP4, M4V, MOV y WebM;
- agrupa variantes de un mismo stream;
- prioriza variantes de mayor resolución;
- separa URLs que parecen audio-only;
- relaciona audio compañero con el video cuando comparten grupo;
- reutiliza imágenes del mismo Pin como poster cuando el video no trae uno.

El backend:
- usa FFmpeg para inspeccionar las pistas;
- descarta recursos que contienen audio pero ninguna pista de video;
- mantiene MP4/H.264 compatibles cuando no necesitan conversión;
- convierte codecs incompatibles a MP4 H.264/AAC;
- intenta combinar un audio compañero si el video principal no trae audio.

## Backend

URL:
`https://wmc-api-production.up.railway.app`

Versión esperada por la extensión: **4.2.4**.

Railway usa `cloud/` como raíz del servicio `wmc-api`.

## Carpeta que debe cargarse en Chrome

`extension/Spencer-Collector-Pro-4.2.4/`

`manifest.json` debe estar directamente dentro de la carpeta seleccionada.

## Regla de mantenimiento

Antes de entregar:
1. comprobar extracción HTTPS;
2. confirmar que Chrome solicita permisos web cuando corresponda;
3. confirmar regreso desde selector a pestaña de origen;
4. comprobar GIF reales y GIF con URL escapada;
5. comprobar video normal, video sin poster, stream audio-only y codec no compatible;
6. comprobar análisis;
7. comprobar ZIP;
8. confirmar que Google Drive no aparece en la extensión;
9. actualizar documentación.
