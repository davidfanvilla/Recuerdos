# Publicar la app privada

Esta version ya no debe publicarse como archivos sueltos si quieres proteger fotos. Debe correr con `server.js`.

## Preparar fotos definitivas

1. Pon las fotos en `photos`.
2. Importalas al almacenamiento privado:

   ```bash
   node tools/import-private-photos.mjs
   ```

Las fotos quedan en `.private/uploads`, que no se sirve como carpeta publica.

## Probar

```bash
SITE_PASSWORD="tu-clave" npm start
```

Si no tienes `npm` disponible:

```bash
SITE_PASSWORD="tu-clave" node server.js
```

Abre `http://localhost:3000`.

## Publicar

En Render, Railway, Fly.io u otro hosting Node:

- Build command: ninguno o `npm install`
- Start command: `npm start`
- Environment variable: `SITE_PASSWORD=una-clave-larga`
- Environment variable opcional: `DATA_DIR=/ruta/persistente`
- Node version: 18 o superior

Para Render deje `render.yaml`. Usa un disco persistente montado en `/var/data`; ahi se guardan las fotos privadas. Sin disco persistente, las fotos subidas desde la web pueden perderse en redeploys o reinicios del hosting.

## Sobre descargas

No existe proteccion perfecta contra descarga o captura si una foto se puede ver en pantalla. Esta app reduce el riesgo con clave privada, sesiones, fotos fuera de la carpeta publica, rutas protegidas, cabeceras `no-store`, bloqueo de indexado y sin enlaces directos publicos.
