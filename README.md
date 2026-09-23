# Spencer Collector Pro · Web Media Collector

Versión activa documentada: **4.2.4**.

## Función actual

Extensión Chrome Manifest V3 para:
1. extraer imágenes, GIF, WebP y videos de una página;
2. seleccionar contenido visualmente;
3. analizar metadatos;
4. descargar un ZIP local.

**Google Drive ya no forma parte del flujo activo de la extensión.**

## Cambios 4.2.4

- El selector recuerda la pestaña donde comenzó el escaneo y vuelve a ella al pulsar **Aplicar selección y cerrar**.
- La detección de GIF se amplió a DOM, atributos, recursos de red, metadatos y HTML embebido.
- Los streams de audio aislados ya no se presentan como videos descargables.
- Variantes del mismo video se agrupan y se prioriza la de mayor resolución.
- Los videos sin poster intentan reutilizar una imagen del mismo Pin.
- El backend normaliza videos incompatibles a MP4 H.264/AAC cuando hace falta.
- Los streams sin pista de video se descartan.
- Si existe un audio compañero separado, el backend intenta incorporarlo al MP4 final.

## Arquitectura activa

```text
Chrome Extension 4.2.4
        |
        +-- extracción y selección en navegador
        |
        +-- Railway /api/metadata
        |
        +-- Railway /api/zip
             |
             +-- FFmpeg: validación / normalización de video
```

Backend:
`https://wmc-api-production.up.railway.app`

## Permisos web

El acceso a páginas se declara con `optional_host_permissions` para `http://*/*` y `https://*/*`, y se solicita al pulsar **Extraer contenido**.

## Versión que debe usarse

`extension/Spencer-Collector-Pro-4.2.4/`

No cargar la raíz completa del repositorio. La carpeta seleccionada en **Load unpacked** debe contener directamente `manifest.json`.

## Documentación

- `docs/CURRENT_STATE.md`: estado funcional vigente.
- `docs/BUG_HISTORY.md`: errores encontrados, causa raíz y correcciones.
- `docs/RELEASE_CHECKLIST.md`: validaciones obligatorias antes de entregar.
- Las versiones anteriores se conservan; no se sobrescriben silenciosamente.

## Seguridad

No desactivar Microsoft Defender ni crear exclusiones para instalar la extensión.
