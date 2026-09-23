# Spencer Collector Pro 4.2.0 · distribución en revisión

El ZIP de descarga directa fue retirado temporalmente porque Windows/Chrome reportó una detección antivirus durante la descarga.

No desactives Microsoft Defender ni agregues exclusiones para instalar esta versión.

Revisión estática realizada sobre el contenido del paquete:
- no se encontraron llamadas a `eval()` ni `new Function()`;
- no se encontraron PowerShell, cmd.exe, WScript, rundll32 ni Native Messaging;
- la extensión usa permisos sensibles legítimos para su función: `activeTab`, `scripting`, `downloads`, `storage` y acceso web amplio;
- el único backend HTTP(S) codificado en la extensión es `https://wmc-api-production.up.railway.app`.

La detección del antivirus debe identificarse antes de volver a publicar un instalable.
