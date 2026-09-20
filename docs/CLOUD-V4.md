# Web Media Collector 4.0 Cloud

## Objetivo

Eliminar la dependencia de `START-WEB-MEDIA-COLLECTOR.cmd` y de `127.0.0.1:8787`.

Arquitectura objetivo:

```text
Chrome Extension 4.0
        |
        | HTTPS + Bearer token
        v
Web Media Collector Cloud (Railway)
        |\
        | \-- PostgreSQL
        |
        \---- Google OAuth / Drive API
                 |
                 +-- Drive del usuario A
                 +-- Drive del usuario B
                 +-- Drive del usuario C
```

## Multiusuario

Cada persona conecta su propio Google Drive mediante OAuth. El backend guarda el refresh token cifrado y todas las consultas quedan aisladas por `user_id`.

## Identificadores

Las colecciones usan una secuencia global que no se reutiliza:

- `WMC-000001 - Pokémon`
- `WMC-000002 - Prueba`
- `WMC-000003 - Pokémon`

Los assets usan identificadores como `IMG-00000001` y `VID-00000002`.

## OAuth

La extensión usa un flujo de autorización por dispositivo: solicita un código efímero al backend, abre Google en una pestaña y después recibe un token de sesión. El `GOOGLE_CLIENT_SECRET`, los refresh tokens y las claves de cifrado nunca se guardan en la extensión ni en GitHub.

La versión cloud necesita un cliente OAuth de Google de tipo **Aplicación web** con:

```text
https://<dominio-railway>/auth/google/callback
```

como URI autorizada de redirección.

## Seguridad

- Refresh tokens cifrados con AES-256-GCM.
- Tokens de sesión almacenados como hash SHA-256.
- OAuth state firmado con HMAC.
- Aislamiento por usuario.
- Secretos fuera de GitHub.
- ZIP temporales eliminados después de descargarse o expirar.
