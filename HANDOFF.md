# HANDOFF / Auditoría — Pro-Gestión (proyecto-pancake)

> Documento de traspaso para el próximo desarrollador. Auditoría: **2026-07-14**.
> Complementa a `CLAUDE.md` (detalle migración-por-migración). Este archivo = mapa de alto nivel + credenciales + estado + deuda.

---

## 1. Qué es

**Pro-Gestión** — plataforma interna de **gestión de proyectos** de Pancake (`pancake.lat`). Una sola SPA React, dos mundos:

- **Staff** (super_admin / admin / gerente / líder de equipos / miembro): CRUD de proyectos, fases, tareas (Gantt), hitos, bitácora, dashboards, equipos, cuestionarios, documentos, reportes de error.
- **Portal cliente** (rol `cliente`): vista read-only de sus proyectos + cuestionarios + documentos (subir/aprobar) + onboarding guiado.

Modela el trabajo que el equipo llevaba en un Excel "Resumen" (Google Sheet `1CI0Vbg4...`). Migraciones 14 y 34–38 seedean/sincronizan los proyectos vivos desde ese Excel.

---

## 2. Stack

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + Vite 5, React Router 6, Zustand, Tailwind (paleta custom `ink-*`) |
| Animación | GSAP (`src/lib/motion.js`, respeta `prefers-reduced-motion`) |
| Backend | **Supabase** (Auth + Postgres + Realtime + Storage + Edge Functions). Sin servidor propio. |
| DB schema | Schema custom **`pro_gestion`** (NO `public`) |
| Rich text | TipTap + DOMPurify (cuestionarios) |
| Export | jsPDF + jspdf-autotable; CSV con BOM |
| Charts | Chart.js + react-chartjs-2 |
| Email | **Gmail SMTP** vía `denomailer` en edge functions (antes Resend, ya migrado) |
| WhatsApp | **Twilio** (process-notifications e invite-user) + API Pancake opcional (invite-user, si se configura `PANCAKE_WA_API_*`) |

Sin test runner. Lint: `npm run lint`.

---

## 3. Correr en local

```bash
npm install
cp .env.example .env      # llenar los 2 valores (§4.1)
npm run dev               # http://localhost:5173
npm run build             # dist/
npm run preview
```

`.env` en raíz, **obligatorio** (sin esto Supabase no inicializa — `src/lib/supabase.js`):
```
VITE_SUPABASE_URL=https://ajtikvqfhylhafuwemnq.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```
Ambos son **públicos por diseño** (van al bundle). La seguridad real la da RLS en Postgres.

---

## 4. Credenciales — dónde vive cada cosa

> ⚠️ **Nada sensible está commiteado.** `.gitignore` excluye `.env` / `.env.*`. Los secrets de servidor viven en **Supabase → Edge Functions → Secrets**, no en el repo. El próximo dev necesita acceso al **dashboard de Supabase** del proyecto.

**Project ref (encontrado en mig-32):** `ajtikvqfhylhafuwemnq` → `https://ajtikvqfhylhafuwemnq.supabase.co`

### 4.1 Frontend (`.env`, público)
| Var | Dónde se obtiene |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Settings → API → `anon` `public` |

### 4.2 Edge Functions (secrets de servidor)
Setear con:
```bash
supabase secrets set \
  SUPABASE_URL=https://ajtikvqfhylhafuwemnq.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  GMAIL_USER=... GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx" \
  APP_BASE_URL=https://progestion.pancake.lat \
  PORTAL_BASE_URL=https://app.pancake.lat \
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_WHATSAPP_FROM="whatsapp:+1..."
```

| Secret | Usado por | Qué es |
|---|---|---|
| `SUPABASE_URL` | todas | URL del proyecto |
| `SUPABASE_SERVICE_ROLE_KEY` | todas | **service_role** — bypassa RLS, NUNCA al cliente. Settings → API → service_role |
| `GMAIL_USER` | notify-deadlines, invite-user, process-notifications | cuenta Gmail remitente |
| `GMAIL_APP_PASSWORD` | idem | **App Password** de Google (16 chars, requiere 2FA). No la contraseña normal |
| `APP_BASE_URL` | invite-user | base para links de invitación (ej. `https://progestion.pancake.lat`) |
| `PORTAL_BASE_URL` | process-notifications | base del portal (default `https://app.pancake.lat`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | process-notifications | **opcional** — WhatsApp. Sin esto, WA cae a email |
| `PANCAKE_WA_API_URL` / `PANCAKE_WA_API_TOKEN` | invite-user | Opcional — API propia de WhatsApp. Sin esto, las invitaciones salen por Twilio |

### 4.3 Cron / pg_cron (dentro de Postgres)
Dos jobs registrados por migraciones. Ambos invocan una edge function con `Bearer <SERVICE_ROLE_JWT>` **hardcodeado en el SQL**:

| Job | Migración | Horario | Function |
|---|---|---|---|
| `notify-deadlines-daily` | mig-17 | `0 9 * * *` UTC (diario) | notify-deadlines |
| `process-notifications-5min` | mig-32 | cada 5 min | process-notifications |

> mig-17 tiene `<PROJECT_REF>` y `<SERVICE_ROLE_JWT>` como **placeholders** → reemplazar al aplicar. mig-32 ya tiene el project ref real (`ajtikvqfhylhafuwemnq`) pero el `<SERVICE_ROLE_JWT>` sigue siendo placeholder.
> **Si rotás la service_role key → actualizar ambos jobs** o dejan de disparar.
> Ver jobs vivos: `select jobname, schedule, active from cron.job;`

### 4.4 Cuentas/accesos que el próximo dev necesita
- **Dashboard de Supabase** (project `ajtikvqfhylhafuwemnq`) — lo central.
- **Cuenta Gmail** de envío + App Password.
- **Twilio** (opcional, para WhatsApp real).
- **Google Sheet "Resumen"** (`1CI0Vbg4BtaPuTrTWJ84yyB3jIV6Hr8ar-BoVEUtsTCE`) — fuente de verdad del negocio.
- **Hosting frontend** — dominios usados: `app.pancake.lat` (portal) / `progestion.pancake.lat` (app staff). Confirmar proveedor (Vercel/Netlify/Cloudflare) con el equipo.

---

## 5. Arquitectura (frontend)

```
main.jsx → BrowserRouter → AuthProvider → App
App.jsx → decide Login vs app; ThemeProvider + I18nProvider; Layout + Routes
         → rutas protegidas por can('permiso')
         → realtime: canal 'pro_gestion_changes' (debounce 350ms → refreshProjects)
```

| Archivo | Rol |
|---|---|
| `src/lib/auth.jsx` | `AuthProvider` + `useAuth()`, `session`+`profile`, matriz `PERMS`, `can(perm)`, `STAFF_ROLES`, `TEAM_LEADER_ROLES` |
| `src/lib/store.js` | Zustand: projects/profiles/categories + refresh/patch |
| `src/lib/data.js` | TODO el acceso a datos. `fetchProjects` = join `projects→phases→tasks`+milestones+members. `friendlyDbError()` mapea errores Postgres a i18n |
| `src/lib/supabase.js` | cliente único (`db: { schema: 'pro_gestion' }`) |
| `src/lib/utils.js` | lógica de negocio pura: progreso, salud, fechas, moneda, STATUSES, PRIORITY, helpers Gantt |
| `src/lib/i18n.jsx` / `theme.jsx` | idioma es/en/pt (`profiles.language`), tema light/dark (localStorage `proTheme`) |
| `notifications.js`/`questionnaires.js`/`clients.js`/`clientTasks.js`/`comments.js`/`reports.js`/`storage.js` | data layers por feature |
| `src/lib/exporters.js` | `downloadCSV` / `downloadPDF` |
| `src/lib/confirm.jsx` / `toast.js` | reemplazos de `window.confirm` / `alert` |
| `src/lib/logger.js` | wrapper de console, solo DEV — **usar siempre en vez de console.*** |

**Páginas** (`src/pages/`): Dashboard, Projects, ProjectDetail, Team, Teams, Admin, AdminActivity, AdminReports, Clients, Settings, Login + carpeta `portal/`. Varias con `lazy()`+`<Suspense>`.

**Componentes clave**: Gantt, ProjectDetailTabs (Información/Seguimiento/Operación/Gestión), ActivityFeed (bitácora), NotifBell (campana realtime), cuestionarios (QuestionnaireEditor/Renderer/Panel), ClientDocsPanel, OnboardingTour, ErrorBoundary, ReportButton (🐛).

---

## 6. Base de datos

- Schema **`pro_gestion`** expuesto vía `pgrst.db_schemas = 'public, pro_gestion'`.
- Modelo: `profiles → projects → phases → tasks` + `project_members` (M:N), `milestones`, `categories`, `platforms`, `questionnaire_templates`, `project_questionnaires`, `documents`, `document_templates`, `notifications`, `activity`, `comments`, `error_reports`, `notification_log`.
- Acceso = **RLS + triggers** (no hay backend). Helpers: `is_admin()`, `is_admin_or_gerente()`, `is_staff()`, `is_super_admin()`, `is_cliente()`, `is_project_client(uuid)`.

### Orden de migraciones (SQL Editor de Supabase, en orden numérico)
```
supabase-setup.sql   ← base (tablas, RLS, grants, triggers)
supabase-migration-2.sql … supabase-migration-41.sql
```
Detalle de cada una: `CLAUDE.md` (documentado hasta 34) + cabecera de cada `.sql`. Resumen de las nuevas:

| Mig | Qué hace |
|---|---|
| 35 | Enriquece los 25 proyectos de mig-34 con datos completos del Excel |
| 36 | Dedup + sync de proyectos (arregla títulos largos de mig-14) |
| 37 | Hitos automáticos al completar fases / entregar proyecto |
| 38 | Sync de campos vacíos desde el Excel (solo llena NULL) |
| 39 | Notif in-app a admins/gerentes ante cualquier actividad en proyectos |
| 40 | **Hotfix de 39** — el trigger de notif no debe romper el registro de actividad |
| 41 | Backfill: crea `project_create` en proyectos sin actividad |

> ⚠️ **Idempotencia no uniforme.** Los seeds (14, 34–38) dependen de matching por título/nombre. Leer la cabecera antes de re-correr. **Nunca correr un seed dos veces sin verificar su `WHERE NOT EXISTS`.**

---

## 7. Edge Functions (`supabase/functions/`)

| Function | Qué hace | Trigger |
|---|---|---|
| `admin-create-client` | staff crea cuenta de cliente (valida Bearer del caller = staff) | app |
| `invite-user` | invita por email (Gmail SMTP). WhatsApp = **STUB** (`pending_api`, devuelve link para copiar) | app |
| `notify-deadlines` | recordatorios de vencimiento por email + notif in-app. Kinds `5d/3d/1d/due/overdue+N`. Respeta `profiles.notif_email_enabled` | cron `notify-deadlines-daily` |
| `process-notifications` | vacía la cola `notifications` por canal `profiles.notif_channel`: `email`(Gmail) / `whatsapp`(Twilio, cae a email si no hay Twilio) / `both` / `none`. Batch 50, solo notifs <24h, idempotente por `email_sent_at`/`wa_sent_at` | cron `process-notifications-5min` |

Deploy: `supabase functions deploy <nombre> --no-verify-jwt`. Leen secrets de `Deno.env.get(...)` (§4.2).

---

## 8. Roles y permisos (DOS capas — deben coincidir)

1. **Cliente**: matriz `PERMS` en `src/lib/auth.jsx` → decide UI/rutas.
2. **Servidor**: RLS en Postgres → decide lectura/escritura.

Roles reales: `super_admin | admin | gerente | lider_equipos | lider_equipo | miembro | cliente`.
`STAFF_ROLES` = todos menos `cliente`. `TEAM_LEADER_ROLES` = `lider_equipos`/`lider_equipo`.

| Permiso | super_admin | admin | gerente | miembro | cliente |
|---|:--:|:--:|:--:|:--:|:--:|
| viewAll | ✓ | ✓ | ✓ | ✗ | ✗ |
| createProject | ✓ | ✓ | ✓ | ✓ | ✗ |
| deleteProject | ✓ | ✓ | ✗ | ✗ | ✗ |
| manageUsers | ✓ | ✓ | ✗ | ✗ | ✗ |
| manageRoles | ✓ | ✗ | ✗ | ✗ | ✗ |
| manageClients | ✓ | ✓ | ✗ | ✗ | ✗ |
| viewKPIs | ✓ | ✓ | ✓ | ✗ | ✗ |
| clientPortal | ✗ | ✗ | ✗ | ✗ | ✓ |

- Primer usuario que se registra → `admin` automático (trigger `handle_new_user`). Los demás → `miembro`.
- **Si agregás capacidad, actualizá LAS DOS capas** o el cliente muestra botones que el server rechaza (error RLS `42501`).

---

## 9. Estado actual (lo que funciona)

- ✅ CRUD de proyectos/fases/tareas/hitos con Gantt (drag/resize a nivel día).
- ✅ Progreso por actividad (`tasks.progress` 0-100 → deriva `completed`).
- ✅ Bitácora automática (triggers) + manual, con tags y realtime.
- ✅ Portal cliente: proyectos read-only, cuestionarios por plataforma (Botcake/CRM/Pancake), documentos, onboarding, gate de datos obligatorios.
- ✅ Notificaciones in-app (campana realtime) + cola multi-canal (email/WhatsApp) + email de vencimientos.
- ✅ Cuestionarios rich-text (TipTap) con plantillas por plataforma.
- ✅ Dashboards, métricas de equipo, export PDF/CSV, reportes de error.
- ✅ i18n es/en/pt, dark mode, responsive (breakpoint `md`), atajos (Cmd+K).
- ✅ Higiene de secrets: nada sensible en el repo.

---

## 10. Deuda técnica / riesgos (para el próximo dev)

- **Sin tests.** Cero cobertura. Refactor a ciegas → agregar Vitest + Testing Library.
- **RLS/triggers históricamente frágiles.** Recursión infinita (mig-11) e incidente mig-39/40 (un trigger rompía el registro de actividad). **Todo trigger nuevo sobre `activity` debe ser a prueba de fallos** (no abortar la transacción principal).
- **Placeholders en cron** (mig-17 y mig-32): reemplazar `<SERVICE_ROLE_JWT>` (y `<PROJECT_REF>` en 17). Rotar service_role = actualizar los jobs o dejan de disparar.
- **41 archivos SQL sueltos**, sin CLI de migración (`supabase/migrations/` no versionado). Orden e idempotencia manuales → riesgo de aplicar fuera de orden.
- **Seeds acoplados al Excel.** Dependen del Google Sheet externo; no se re-sincronizan solos si el negocio cambia el sheet.
- **WhatsApp**: `invite-user` manda por API de Pancake si `PANCAKE_WA_API_*` está seteado, si no por Twilio (`TWILIO_*`, los mismos secrets de `process-notifications`); sin ninguno de los dos queda en modo manual (`pending_api`). La API de Pancake sigue sin existir: el camino en producción es Twilio.
- **`legacy/`** — predecesor vanilla JS, no se importa, no tocar salvo pedido.
- **`data.js` monolítico** — concentra todo el acceso a datos; candidato a dividir por dominio.
- **Dominio de app** no está en el repo; confirmar hosting con el equipo.

---

## 11. Checklist para arrancar (nuevo dev)

1. Pedir acceso al **dashboard de Supabase** (`ajtikvqfhylhafuwemnq`) + cuenta **Gmail** de envío (+ Twilio si se usa WhatsApp).
2. `git clone` → `npm install` → `.env` con URL + anon key.
3. `npm run dev` y loguearse.
4. Confirmar edge functions deployadas y secrets seteados: `supabase secrets list`.
5. Verificar cron: `select jobname, schedule, active from cron.job;` (deben estar `notify-deadlines-daily` y `process-notifications-5min`).
6. Leer `CLAUDE.md` + cabecera de cada `.sql`.
7. Antes de aplicar cualquier migración en prod: leer su cabecera y confirmar idempotencia.

---

## 12. Referencias rápidas

- Detalle por migración → `CLAUDE.md`.
- Fuente del negocio → Google Sheet "Resumen" `1CI0Vbg4BtaPuTrTWJ84yyB3jIV6Hr8ar-BoVEUtsTCE`.
- Acceso a datos → `src/lib/data.js`. Lógica → `src/lib/utils.js`. Permisos → `src/lib/auth.jsx`. Edge functions → `supabase/functions/`.

---

## 13. Traspaso de infraestructura (cambio de dueño → corporativolat)

Al cambiar el repo git a **corporativolat**, hay que mover también **Vercel** y **Supabase** a la cuenta corporativa. Ambas son operaciones de **dashboard** (no hay CLI/API para transferir dueño de proyecto).

### 13.1 Git — HECHO
- Repo destino: **`github.com/corporativolat/proyecto-pancake`** (público).
- HANDOFF y código ya viven ahí (`main`).
- Repo viejo `samintone2106/proyecto-pancake` queda como histórico / se puede archivar.

### 13.2 Vercel — transferir proyecto
Hosting actual: Vite build estático + SPA rewrite (`vercel.json`). Dominios: `app.pancake.lat` (portal) / `progestion.pancake.lat` (staff).

Pasos (en el dashboard de Vercel):
1. **Crear/usar el team corporativo** en Vercel (el que tenga el dominio `pancake.lat`).
2. Proyecto actual → **Settings → Advanced → Transfer Project** → elegir el team corporativo. *(O borrar el proyecto viejo y re-importar el repo desde cero — ver paso 4.)*
3. **Reconectar el Git**: Settings → Git → conectar `corporativolat/proyecto-pancake` (branch `main`). Esto exige que la cuenta de Vercel tenga el **GitHub App de Vercel** autorizado sobre la org/cuenta corporativolat.
4. Si se re-importa desde cero: New Project → import `corporativolat/proyecto-pancake` → framework **Vite** → build `npm run build` → output `dist`.
5. **Re-cargar env vars** (Settings → Environment Variables, scope Production + Preview):
   - `VITE_SUPABASE_URL = https://ajtikvqfhylhafuwemnq.supabase.co`
   - `VITE_SUPABASE_ANON_KEY = <anon-key>`
6. **Re-apuntar los dominios** `app.pancake.lat` / `progestion.pancake.lat` al proyecto en el nuevo team (Settings → Domains). Ajustar DNS si el registrador cambió.
7. **Redeploy** y verificar login + carga de proyectos.

> Los env de Vercel NO se transfieren solos en un re-import; hay que volver a pegarlos.

### 13.3 Supabase — transferir proyecto
Proyecto: **`ajtikvqfhylhafuwemnq`** (`https://ajtikvqfhylhafuwemnq.supabase.co`).

**Refs reales (auditados 2026-07-14):**
- DB de producción con datos = **`ajtikvqfhylhafuwemnq`** (org de samintone).
- Proyecto vacío en la cuenta corporativa = **`scxbiddquodrdhqvhphz`** ("corporativo@pancake.lat's Project"), org **`ggfltmfdlvhyrmdexggh`**.

**Opción A — Transfer de proyecto (recomendada, conserva datos y URL):**
1. Entrar con la cuenta dueña de `ajtikvqfhylhafuwemnq` (samintone).
2. Agregar `corporativo@pancake.lat` como **Owner** de esa org de origen (Organization → Team → Invite). El transfer exige ser miembro de **ambas** orgs.
3. Proyecto `ajtikvqfhylhafuwemnq` → **Settings → General → Transfer project** → elegir la org corporativa `ggfltmfdlvhyrmdexggh`. La org destino suele necesitar **plan pago (Pro)**. Ref y URL **no cambian** → Vercel no se toca.
3. Como el ref (`ajtikvqfhylhafuwemnq`) y la URL **no cambian**, `VITE_SUPABASE_URL` y anon key **siguen válidos** → no hay que tocar el frontend.
4. **Re-setear los secrets de edge functions** en la nueva org (no viajan con el transfer):
   ```bash
   supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
     GMAIL_USER=... GMAIL_APP_PASSWORD="..." APP_BASE_URL=... PORTAL_BASE_URL=... \
     TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_WHATSAPP_FROM=...
   ```
5. **Verificar los 2 cron jobs** (`notify-deadlines-daily`, `process-notifications-5min`): `select jobname, schedule, active from cron.job;`. Si la service_role key cambió, **actualizar el `Bearer <SERVICE_ROLE_JWT>` de los jobs** (re-correr el `cron.schedule` de mig-17 y mig-32 con el JWT nuevo).
6. Re-deploy de las 4 edge functions: `supabase functions deploy <nombre> --no-verify-jwt`.

**Opción B — Proyecto nuevo + migrar datos (si no se puede transferir):**
- Crear proyecto nuevo en la org corporativa → correr `supabase-setup.sql` + `migration-2..41` en orden → `pg_dump`/restore de los datos → **cambia el ref y la URL** → actualizar `VITE_SUPABASE_URL`/anon key en Vercel + `APP_BASE_URL`/dominios. Más trabajo y más riesgo; usar solo si el transfer directo no está disponible.

### 13.4 Accesos a dejar registrados (llenar con los valores reales)

| Recurso | Dónde | Dueño / cuenta corporativa | Notas |
|---|---|---|---|
| Repo GitHub | `github.com/corporativolat/proyecto-pancake` | corporativolat | ✅ ya transferido |
| Vercel | team: `<team-vercel-corporativo>` | `<email admin Vercel>` | proyecto: `<nombre-proyecto>`; dominios app./progestion.pancake.lat |
| Supabase | org: `<org-supabase-corporativa>` | `<email admin Supabase>` | project ref `ajtikvqfhylhafuwemnq` |
| Gmail remitente | `<cuenta@gmail>` | — | App Password activo (2FA on) |
| Twilio | `<cuenta Twilio>` | — | opcional (WhatsApp) |
| Dominio DNS | `<registrador>` | — | `pancake.lat` y subdominios |
| Google Sheet "Resumen" | `1CI0Vbg4BtaPuTrTWJ84yyB3jIV6Hr8ar-BoVEUtsTCE` | — | fuente operativa del negocio |

> ⚠️ **No pegar contraseñas ni keys en este archivo** (el repo es público). Guardar los secretos en un gestor (Vault de Supabase, 1Password, etc.) y acá solo referenciar **dónde** están y **quién** es el dueño.
