# Historial de incidencias y correcciones

## 4.2.0 — distribución bloqueada por Defender
Windows Defender clasificó el ZIP reconstruido como `Trojan:Script/Ulthar.A!ml`.

Decisión:
- no desactivar Defender;
- no usar exclusiones;
- reducir permisos y revisar el paquete.

## 4.2.1 — permisos reducidos
Se retiraron permisos innecesarios. La extensión dejó de distribuirse como paquete ejecutable y se mantuvo como extensión Chrome descomprimida.

## 4.2.2 — primer intento de corregir el escaneo
Se eliminó la interfaz de Google Drive.
El diagnóstico mejoró, pero el manifiesto quedó sin permiso para acceder al host de la página escaneada.

Síntoma:
`Cannot access contents of the page. Extension manifest must request permission to access the respective host.`

Causa real:
`chrome.scripting.executeScript()` intentaba inyectar el escáner en la pestaña, pero el manifiesto solo tenía permiso para el backend Railway.

## 4.2.3 — corrección definitiva del permiso de escaneo
Se agregó:
- `optional_host_permissions`: `http://*/*`, `https://*/*`;
- solicitud explícita de permiso al pulsar **Extraer contenido**;
- eliminación completa del código de Google Drive de la extensión activa.

La extensión ya no depende de leer `tab.url` para decidir si una página es escaneable.


## 4.2.4 — selector, GIF y streams de video

### Selector deja al usuario fuera del flujo
Síntoma: al abrir el selector en una pestaña nueva y cerrarlo, el navegador no garantizaba volver a la pestaña donde se inició el escaneo.

Corrección:
- se guarda `sourceTabId` y `sourceWindowId` en la sesión;
- al aplicar/cerrar, se reactiva `sourceTabId` antes de cerrar el selector.

### GIF detectados como 0
La lógica anterior dependía demasiado de una URL con extensión `.gif`.

Se recuperó la estrategia usada en el problema anterior de contenido animado: revisar DOM, atributos, recursos ya cargados y HTML serializado, normalizando URLs escapadas. También se reconocen parámetros de formato GIF.

### Videos descargados sin imagen o inutilizables
Se observaron variantes con nombres tipo `_audio`, `_240w`, `_360w`, etc. Algunas corresponden a pistas separadas o variantes de un mismo medio.

Corrección:
- streams audio-only se separan y no se muestran como video;
- variantes de un mismo video se agrupan;
- se prioriza la mejor resolución;
- si hay poster del mismo Pin se reutiliza;
- el backend inspecciona las pistas con FFmpeg;
- audio-only se descarta;
- codecs incompatibles se convierten a MP4 H.264/AAC;
- si hay audio compañero y el video principal no trae audio, se intenta combinar.
