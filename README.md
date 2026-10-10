# CargaYa Demo — delivery multirrubro pesado (construcción, repuestos, industria)  
  
Backend todo-en-uno (cotizador de flete por peso/volumen + checkout + dispatch  
con rondas de ofertas + app de conductor con fotos geo-verificadas + admin con  
ledger) + página de demo interactiva con botones.  
  
## Setup (15 minutos, sin consola)  
  
### 1. Base de datos (gratis)  
1. Entrá a https://neon.tech → Sign up (con GitHub)  
2. New Project → nombre "cargaya" → Create  
3. Abrí el **SQL Editor** → pegá TODO el contenido de `schema.sql` → **Run**  
4. En el Dashboard, copiá la **connection string** (la que dice "pooled")  
  
### 2. Subir a GitHub (sin consola)  
1. https://github.com/new → nombre "cargaya-demo" → **Create repository**  
2. En la pantalla del repo vacío, hacé clic en **"uploading an existing file"**  
3. Arrastrá los 4 archivos → **Commit changes**  
  
### 3. Deploy en Render (gratis)  
1. https://render.com → Sign in con GitHub  
2. **New + → Web Service** → elegí el repo `cargaya-demo`  
3. Configuración:  
   - Runtime: **Node**  
   - Build command: *(dejar vacío)*  
   - Start command: `node server.js`  
   - Instance type: **Free**  
4. **Environment** → Add Environment Variable:  
   - `DATABASE_URL` = (la connection string de Neon)  
   - `JWT_SECRET` = demo123  
5. **Create Web Service** → esperá el deploy → abrí la URL  
  
### 4. Probar  
Abrí la URL → botón **▶️ Correr demo completa** → mirá el log 🎉  
  
## Notas  
- El free tier de Render duerme tras 15 min sin uso: la primera carga tarda  
  ~50s. Solución gratis: https://uptimerobot.com con ping HTTP cada 10 min.  
- `GET /dev/tokens` devuelve los 4 tokens JWT (para Postman/curl).  
- `GET /api/parts/search?oem=7701207213` → búsqueda de repuestos por OEM.  
- `POST /api/dev/reset` → resetea los datos de prueba.  
  
## Qué está simplificado respecto al diseño completo  
- Distancias: haversine ×1.35 (sin Google Maps API).  
- WebSocket: reemplazado por polling cada 4s.  
- Fotos: se valida la geolocalización real (<200 m), el binario no se sube a S3.  
- Pagos: mock (el flujo "cash" es end-to-end real).  
