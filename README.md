# Spencer Collector Pro · Web Media Collector

Versión operativa documentada: **4.2.0**.

Este repositorio conserva únicamente la arquitectura funcional actual del proyecto. La documentación histórica y las versiones anteriores ya no forman parte del árbol activo.

## Qué hace

Spencer Collector Pro es una extensión de Chrome con panel lateral para:

1. extraer imágenes, GIF, WebP y videos visibles en una página;
2. seleccionar o descartar contenido manualmente;
3. detectar duplicados visuales y conservar la mejor copia disponible;
4. analizar bytes y metadatos;
5. generar un ZIP auditable;
6. subir los recursos seleccionados a Google Drive por colección;
7. registrar cada activo y sus fuentes en la base de datos;
8. actualizar automáticamente el navegador de metadatos en Google Sheets después de cada carga.

La selección es global: solo los recursos seleccionados pasan al análisis, ZIP y Google Drive.

## Arquitectura funcional

```text
Chrome Extension 4.2.0
        |
        | HTTPS / Bearer session
        v
Railway · wmc-api
        |
        +---- Google OAuth 2.0 ----> Google Drive del usuario
        |
        +---- WMC DB Edge Function ----> Supabase PostgreSQL
```

### Componentes utilizados

- **Chrome Extension Manifest V3**: interfaz, extracción, selección y control del flujo.
- **Railway**: backend Node.js desplegado en la nube.
- **Google Cloud / OAuth 2.0**: autorización individual para cada cuenta de Google.
- **Google Drive API**: creación de carpetas, carga y organización por formato y colección.
- **Supabase PostgreSQL**: catálogo de usuarios, sesiones, colecciones, archivos, fuentes y metadatos.
- **Supabase Edge Function `wmc-db`**: única puerta de acceso del backend a operaciones de base de datos.
- **GitHub**: repositorio fuente y respaldo recuperable del paquete 4.2.0.

Backend operativo:

```text
https://wmc-api-production.up.railway.app
```

Comprobación:

```text
GET /api/health
```

## Flujo de autenticación

La extensión no guarda secretos de Google.

1. La extensión llama `POST /api/auth/device/start`.
2. El backend crea una autorización temporal.
3. El usuario autoriza su propia cuenta de Google mediante OAuth.
4. Google devuelve el callback al backend.
5. El refresh token se cifra antes de persistirse.
6. La extensión recibe una sesión propia y la guarda localmente.
7. Las siguientes llamadas usan `Authorization: Bearer <session>`.

Endpoints principales:

- `POST /api/auth/device/start`
- `GET /auth/google/start`
- `GET /auth/google/callback`
- `POST /api/auth/device/poll`
- `GET /api/me`
- `POST /api/logout`
- `GET /api/drive/status`
- `POST /api/analyze`
- `POST /api/zip`
- `POST /api/ingest/start`
- endpoints de estado/progreso asociados a trabajos de subida

## Google Drive

Cada usuario autoriza su propia cuenta. El backend crea o reutiliza la estructura de trabajo de **Web Media Collection** y organiza recursos por:

- JPG
- PNG
- GIF
- WEBP
- VIDEO
- THUMBNAILS

Dentro de cada categoría se crean subcarpetas de colección. Los nombres se normalizan antes de crear la colección.

No se deben codificar IDs personales de carpetas en la extensión. Los IDs operativos se guardan por usuario en la base de datos.

## Navegador automático de metadatos

Cada usuario que conecta Google Drive obtiene o reutiliza el archivo **Web Media Collection · Navegador de Metadatos** dentro de su carpeta raíz `Web Media Collection`.

El backend lo sincroniza automáticamente al terminar cada lote de subida. También existe sincronización manual autenticada:

```text
POST /api/metadata-sheet/sync
```

Pestañas mantenidas automáticamente:

- **Dashboard**: métricas generales y cobertura.
- **Navegador**: catálogo completo con filtros.
- **Hallazgos**: solo activos con señales especialmente interesantes (creador, país, ciudad, cámara/celular, fecha, GPS o descripción).
- **Cobertura**: porcentaje de archivos que contienen cada tipo de dato.
- **Colecciones**: relación de colecciones y volumen.
- **Diccionario**: significado y procedencia de campos.
- **Metadata cruda**: JSON completo para auditoría.

Los datos no encontrados se mantienen vacíos; el sistema no inventa identidad, ubicación ni dispositivo.

## Metadatos y catálogo

Un activo se identifica por UUID interno, número secuencial, identificador humano y SHA-256.

Formato humano nuevo:

- `IMG-01`, `IMG-02`, ...
- `VID-01`, `VID-02`, ...

El catálogo puede almacenar:

- formato y MIME;
- tamaño en bytes;
- dimensiones;
- duración;
- SHA-256;
- ID de Google Drive;
- fecha de captura;
- fabricante y modelo de cámara;
- software;
- ISO;
- exposición;
- apertura;
- distancia focal;
- GPS;
- ciudad y país cuando realmente puedan determinarse;
- descripción;
- creador/autor cuando exista en metadatos;
- título, ALT, ARIA y contexto de origen;
- URL directa y página de origen;
- metadatos extendidos en JSON.

**No se inventan datos.** Si una persona, ubicación, cámara, fecha u otro atributo no está respaldado por el archivo o la fuente, se deja vacío.

### Duplicados

1. La URL canónica sirve como prevalidación.
2. SHA-256 determina identidad exacta por bytes.
3. Recursos visualmente iguales reescalados o recodificados pueden detectarse mediante huella perceptual.
4. Un mismo activo puede conservar varias relaciones de origen.

## Base de datos

Tablas operativas:

- `users`
- `drive_accounts`
- `sessions`
- `device_auth`
- `user_drive_folders`
- `collections`
- `collection_drive_folders`
- `assets`
- `asset_sources`
- `collection_assets`
- `backend_auth`

RLS permanece habilitado. El navegador no accede directamente a las credenciales del backend.

## Variables del backend

Configurar en Railway. **Nunca guardar valores reales en GitHub.**

```text
APP_BASE_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
NODE_ENV
SESSION_DAYS
SESSION_SECRET
SUPABASE_PUBLISHABLE_KEY
SUPABASE_URL
TOKEN_ENCRYPTION_KEY
WMC_DB_BACKEND_KEY
WMC_DB_FUNCTION_URL
```

## Estructura final del repositorio

```text
/
├─ README.md
├─ .gitignore
├─ cloud/
│  ├─ .env.example
│  ├─ media.js
│  ├─ package.json
│  ├─ railway.json
│  ├─ schema.sql
│  └─ server.js
└─ backup/
   └─ extension-4.2.0/
      ├─ RESTORE.ps1
      └─ web-media-collector-4.2.0.zip.b64.part01 ... part07
```

## Recuperar la extensión 4.2.0

El respaldo contiene el ZIP completo de la extensión, dividido en partes de texto para conservarlo de forma segura en GitHub.

En Windows:

```powershell
cd backup\extension-4.2.0
.\RESTORE.ps1
```

El script reconstruye:

```text
web-media-collector-4.2-spencer-collector-pro-final.zip
```

y comprueba el SHA-256 esperado:

```text
0662f180fff252369ee4023451595832fcae23c06ca194903e3b3160b7e6c8ef
```

Después extrae una copia lista para cargar desde `chrome://extensions` con **Modo de desarrollador > Cargar descomprimida**.

## Actualización futura

Antes de modificar producción:

1. comprobar `/api/health`;
2. confirmar que Railway despliega `cloud/`;
3. mantener compatibles extensión y backend;
4. aplicar cambios de esquema de forma migrable;
5. probar autenticación OAuth con una cuenta de prueba;
6. probar análisis, ZIP y subida a Drive;
7. comprobar que los metadatos nuevos llegan al catálogo;
8. actualizar este README para que represente solo el sistema funcional vigente.

## Seguridad

- No subir client secrets, refresh tokens, session secrets ni claves de cifrado.
- No exponer claves de Supabase con permisos de servicio.
- Los tokens de Google se cifran antes de persistirse.
- Las cuentas de Drive son independientes por usuario.
- Los metadatos descriptivos deben ser trazables; no se deben inferir identidades personales sin evidencia.
