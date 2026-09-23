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
