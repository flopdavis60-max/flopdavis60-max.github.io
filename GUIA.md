# Sonora: guía de instalación

Sonora es tu reproductor de música estilo Spotify que lee tus canciones de **Google Drive** y las reproduce **en su calidad original**: si subes FLAC 24-bit, escuchas FLAC 24-bit. Es gratis y no tiene anuncios.

Hay cuatro pasos, y solo se hacen una vez (unos 20 minutos en total):

1. Publicar la app en internet gratis con **GitHub Pages**.
2. Crear tu "llave" de Google para que la app pueda leer tu Drive.
3. Instalarla en tu **PC**.
4. Generar la **APK** para Android.

---

## Paso 1. Publicar la app en GitHub Pages

1. Crea una cuenta gratis en <https://github.com> (si no tienes). Fíjate bien en tu **nombre de usuario**, por ejemplo `juanperez`.
2. Arriba a la derecha pulsa **+ → New repository**.
3. En **Repository name** escribe exactamente: `TU-USUARIO.github.io` (por ejemplo `juanperez.github.io`).
   > Este nombre especial hace que la app quede en la raíz de tu dominio, cosa que la APK necesita para verse a pantalla completa.
4. Déjalo como **Public** y pulsa **Create repository**.
5. En la página del repositorio pulsa **uploading an existing file**.
6. Abre la carpeta `sonora` que te di (ya descomprimida), selecciona **todo lo que hay dentro** (incluido el archivo `.nojekyll` y la carpeta `icons`) y arrástralo a la página. Pulsa **Commit changes**.
   > En Windows, para ver `.nojekyll`: Explorador → **Vista → Mostrar → Elementos ocultos**.
7. Ve a **Settings → Pages**. En *Build and deployment* elige **Deploy from a branch**, rama **main**, carpeta **/ (root)** y pulsa **Save**.
8. Espera 1 o 2 minutos. Tu app quedará en: **`https://TU-USUARIO.github.io/`**

Si la abres ahora ya puedes usar el botón **"Probar con música de demostración"**.

---

## Paso 2. Crear tu llave de Google (Client ID)

1. Entra a <https://console.cloud.google.com> con la **misma cuenta de Google donde tienes tu música**.
2. Arriba, en el selector de proyectos, pulsa **Nuevo proyecto**, ponle de nombre `Sonora` y pulsa **Crear**. Asegúrate de tenerlo seleccionado.
3. **Activa la API de Drive:** en el buscador de arriba escribe **Google Drive API**, ábrela y pulsa **Habilitar**.
4. **Configura la pantalla de permisos:** busca **Google Auth Platform** (también puede aparecer como *Pantalla de consentimiento de OAuth*) y pulsa **Comenzar**:
   - Nombre de la app: `Sonora`. Correo de asistencia: el tuyo.
   - Público: **Externo**.
   - Datos de contacto: tu correo. Acepta y pulsa **Crear**.
5. Dentro de Google Auth Platform ve a **Público** y, en **Usuarios de prueba**, pulsa **Add users** y agrega **tu propio correo de Gmail**. Guarda.
6. Ve a **Clientes → Crear cliente**:
   - Tipo de aplicación: **Aplicación web**.
   - Nombre: `Sonora web`.
   - En **Orígenes autorizados de JavaScript** pulsa *Agregar URI* y escribe: `https://TU-USUARIO.github.io` (sin barra al final).
   - Pulsa **Crear**.
7. Copia el **ID de cliente**. Se ve así: `1234567890-abc123.apps.googleusercontent.com`.
8. Vuelve a tu repositorio en GitHub, abre el archivo **`config.js`**, pulsa el lápiz ✏️ para editarlo y pega tu ID entre las comillas:
   ```js
   window.SONORA_CONFIG = {
     GOOGLE_CLIENT_ID: "1234567890-abc123.apps.googleusercontent.com"
   };
   ```
   Pulsa **Commit changes**. Espera un minuto.

Abre tu app y pulsa **Conectar Google Drive**. Google te mostrará el aviso *"Google no verificó esta app"*. Es normal porque la app es tuya y no está publicada: pulsa **Continuar** y acepta el permiso de **ver tus archivos de Drive**. La app solo **lee**: nunca modifica ni borra nada.

> **Tip:** sube tu música a una carpeta llamada `Musica` en Drive, con subcarpetas `Artista/Álbum/canciones`. Luego, en **Ajustes ⚙️ → Carpeta de música**, escribe `Musica` para que la app solo busque ahí.

---

## Paso 3. Instalar en tu PC (Windows, Mac o Linux)

1. Abre `https://TU-USUARIO.github.io/` en **Google Chrome** o **Microsoft Edge**.
2. En la barra de direcciones aparece un ícono de **instalar** (una pantallita con una flecha). Púlsalo y elige **Instalar**.
   - En Edge también está en **⋯ → Aplicaciones → Instalar este sitio como una aplicación**.
3. Listo: Sonora queda en el menú Inicio y en el escritorio, y se abre en su propia ventana, como cualquier programa.

Atajos en PC: **Espacio** = reproducir/pausar · **← →** = retroceder/adelantar 5 s · **Ctrl + ← →** = canción anterior/siguiente.

---

## Paso 4. Generar la APK para Android

La APK se genera gratis con **PWABuilder**, una herramienta de Microsoft. Usa el motor de Chrome, así que la app funciona igual de fluida y el inicio de sesión con Google sí funciona (en las APK "caseras" Google suele bloquearlo).

1. Entra a <https://www.pwabuilder.com>, pega `https://TU-USUARIO.github.io/` y pulsa **Start**.
2. Cuando termine el análisis pulsa **Package For Stores** y luego **Android → Generate Package**.
   - En las opciones puedes cambiar **Package ID** a algo como `com.tunombre.sonora`. Lo demás déjalo igual.
3. Descarga el `.zip` y descomprímelo. Dentro encontrarás:
   - Un archivo **`.apk`**: es la app.
   - Un archivo **`assetlinks.json`**: sirve para que la app se vea a pantalla completa.
   - Un archivo **signing.keystore** con su contraseña: **guárdalos bien**, los necesitarás para crear actualizaciones de la APK.
4. **Para quitar la barra de dirección de arriba:** en tu repositorio de GitHub pulsa **Add file → Create new file** y escribe como nombre `.well-known/assetlinks.json`. Pega dentro el contenido del `assetlinks.json` que descargaste y pulsa **Commit changes**.
5. **Instala la APK en tu celular:** pásala al teléfono (por cable, Drive o WhatsApp), ábrela y, si Android lo pide, permite **"Instalar apps desconocidas"** para esa app.

Abre Sonora en el teléfono y pulsa **Conectar Google Drive**. Los controles aparecen en la notificación y en la pantalla bloqueada.

---

## Preguntas frecuentes

**¿En qué calidad se reproduce?**
En la original. La app no convierte ni comprime nada: le pide el archivo tal cual a Drive. En el reproductor verás la calidad real, por ejemplo **HI-RES · FLAC · 24-bit / 96 kHz** o **MP3 · 320 kbps**.

**¿Qué formatos funcionan?**
FLAC, MP3, WAV, M4A/AAC, OGG y OPUS. **ALAC** (el formato sin pérdida de Apple) no se puede reproducir en algunos dispositivos. Si tienes música sin pérdida, usa **FLAC**.

**¿Por qué a veces aparece "Reconectar"?**
Por seguridad, Google da permisos de 1 hora. Al pulsar *Reconectar* o *Play*, la app los renueva. A veces se abre y cierra una ventanita de Google.

**Subí canciones nuevas y no aparecen.**
Ve a **Ajustes ⚙️ → Volver a escanear**. La app también escanea sola cada vez que la abres.

**Hice cambios al código y no se ven.**
Abre `sw.js` y cambia `sonora-v1` por `sonora-v2` (y así cada vez). Luego recarga la app dos veces.

**¿Es seguro?**
Tu música y tu sesión se quedan entre tu dispositivo y Google. No hay ningún servidor intermedio. La app solo tiene permiso de lectura.
