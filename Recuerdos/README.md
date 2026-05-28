# Red de recuerdos

Regalo interactivo para fotos: cada recuerdo aparece como una esfera 3D dentro de un universo. Al tocarla, se abre la foto con su año.

La version privada usa `server.js`: pide clave, guarda fotos fuera de la carpeta publica y solo entrega imagenes a sesiones autorizadas.

## Probar ahora

Para probar como regalo privado:

```bash
SITE_PASSWORD="tu-clave" npm start
```

Luego abre `http://localhost:3000`.

Tambien puedes abrir `index.html` directamente para pruebas locales sin backend.

La página intenta leer el año original desde metadatos EXIF en archivos JPEG. Si no encuentra ese dato, usa la fecha del archivo como aproximación.

Las fotos que se añadan desde la version privada se guardan en el servidor. Las fotos que se añadan abriendo `index.html` como archivo local se guardan solo en ese celular/navegador.

## Dejarlo como regalo fijo

1. Pon las fotos definitivas en la carpeta `photos`.
2. Importalas al almacenamiento privado:

   ```bash
   node tools/import-private-photos.mjs
   ```

3. Publica el proyecto como app Node. Ver `DEPLOY.md`.

Para iPhone, conviene exportar las fotos como JPEG si quieres conservar mejor el año original.

Nota: no existe proteccion perfecta contra capturas o extraccion avanzada si una foto se ve en pantalla. Esta app protege contra acceso publico, enlaces directos y descargas casuales.
