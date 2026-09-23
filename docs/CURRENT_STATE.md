# Estado actual del proyecto

## Versión activa
**Spencer Collector Pro 4.2.3**

Fecha de corrección: 2026-09-22.

## Flujo funcional vigente

1. Extraer imágenes, GIF, WebP y videos de la pestaña web activa.
2. Seleccionar o descartar recursos.
3. Analizar información y metadatos.
4. Descargar un ZIP.

La extensión activa **no sube archivos a Google Drive**.

Railway se conserva únicamente para:
- comprobación de salud del servicio;
- análisis profundo de metadatos;
- construcción del ZIP final.

Backend configurado:
`https://wmc-api-production.up.railway.app`

## Permisos de Chrome

Permisos base:
- `activeTab`
- `scripting`
- `sidePanel`
- `storage`

Acceso web:
- declarado como `optional_host_permissions` para `http://*/*` y `https://*/*`;
- se solicita al usuario al pulsar **Extraer contenido**;
- esto corrige el error `Cannot access contents of the page. Extension manifest must request permission to access the respective host.`.

## Carpeta que se debe cargar en Chrome

`extension/Spencer-Collector-Pro-4.2.3/`

El archivo `manifest.json` debe estar directamente dentro de esa carpeta.

## Regla de mantenimiento

No entregar una nueva versión sin:
1. actualizar el número de versión;
2. probar extracción en una página HTTPS real;
3. confirmar que el selector abre;
4. confirmar que el análisis responde;
5. confirmar que el ZIP se genera;
6. confirmar que no aparece ninguna sección de Google Drive;
7. actualizar esta documentación y CHANGELOG.
