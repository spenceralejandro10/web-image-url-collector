# Spencer Collector Pro · Web Media Collector

Versión activa documentada: **4.2.3**.

## Función actual

Extensión Chrome Manifest V3 para:
1. extraer imágenes, GIF, WebP y videos de una página;
2. seleccionar contenido;
3. analizar metadatos;
4. descargar un ZIP.

**Google Drive fue eliminado de la extensión activa.**

## Arquitectura actual

```text
Chrome Extension 4.2.3
        |
        +-- escaneo y selección en el navegador
        |
        +-- Railway /api/metadata
        |
        +-- Railway /api/zip
```

Backend:
`https://wmc-api-production.up.railway.app`

## Permiso para escanear páginas

El acceso web se declara como permiso opcional y se solicita al pulsar **Extraer contenido**. Esto evita el fallo de 4.2.2:

`Cannot access contents of the page. Extension manifest must request permission to access the respective host.`

## Versión que debe usarse

`extension/Spencer-Collector-Pro-4.2.3/`

No cargar la raíz completa del repositorio en Chrome. La carpeta correcta es la que contiene directamente `manifest.json`.

## Documentación

- `docs/CURRENT_STATE.md`: estado funcional vigente.
- `docs/BUG_HISTORY.md`: errores encontrados y causa raíz.
- `docs/RELEASE_CHECKLIST.md`: validaciones obligatorias antes de entregar una versión.

## Regla de seguridad

No desactivar Microsoft Defender ni crear exclusiones para instalar la extensión.
