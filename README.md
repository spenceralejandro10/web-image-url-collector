# Web Image URL Collector

Extensión local para Chrome/Edge que detecta las URLs directas de imágenes ya cargadas en la pestaña actual.

## Funciones v0.1

- Detecta `img.src` y `img.currentSrc`.
- Extrae candidatos de `srcset`.
- Detecta imágenes usadas mediante `background-image`.
- Elimina URLs duplicadas.
- Permite filtrar recursos de `pinimg.com`.
- Muestra una vista previa.
- Copia una URL o todas las URLs al portapapeles.

## Instalar en Chrome

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions/`.
3. Activa **Modo de desarrollador**.
4. Pulsa **Cargar descomprimida**.
5. Selecciona la carpeta del proyecto.
6. Abre una página, pulsa la extensión y selecciona **Escanear página**.

## Edge

Usa `edge://extensions/` y sigue el mismo procedimiento.

## Nota

La extensión analiza únicamente los recursos presentes en la pestaña cargada en el navegador. El uso del contenido obtenido debe respetar los derechos aplicables y las condiciones del sitio de origen.
