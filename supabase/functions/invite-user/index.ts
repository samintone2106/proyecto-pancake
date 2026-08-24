/*
 * Supabase Edge Function: invite-user
 *
 * Recibe { invitation_id } y dispara el envío del canal de la invitación.
 *
 *   - channel='email':    envía un email vía Gmail SMTP (mismo patrón
 *                         que notify-deadlines).
 *   - channel='whatsapp': intenta, en este orden:
 *                         1. API propia de Pancake (PANCAKE_WA_API_*), si
 *                            está configurada.
 *                         2. Twilio (TWILIO_*), el mismo canal que ya usa
 *                            `process-notifications`.
 *                         3. Si no hay ninguno, STUB: devuelve
 *                            { ok: true, channel_status: 'pending_api', link }
 *                            para que el cliente copie el link y lo envíe
 *                            manualmente.
 *
 * Variables (configurar con `supabase secrets set`):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - GMAIL_USER             ← cuenta Gmail remitente
 *   - GMAIL_APP_PASSWORD     ← App Password de Google
 *   - APP_BASE_URL           ← origen del frontend (ej. https://progestion.pancake.lat)
 *                              si falta, intentamos derivarlo del header Origin.
 *   - PANCAKE_WA_API_URL     ← endpoint de WhatsApp de Pancake (opcional)
 *   - PANCAKE_WA_API_TOKEN   ← bearer token de la API de Pancake (opcional)
 *   - TWILIO_ACCOUNT_SID     ← fallback de WhatsApp (opcional)
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_WHATSAPP_FROM   ej. "whatsapp:+14155238886" (sandbox) o tu
 *                              número aprobado en producción.
 *
 * Deploy:
 *   supabase functions deploy invite-user --no-verify-jwt
 *
 * Llamado típico desde el cliente:
 *   supabase.functions.invoke('invite-user', { body: { invitation_id } })
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function buildLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/?invite=${encodeURIComponent(token)}`;
}

// Normaliza a dígitos para Twilio (E.164 sin +). Móvil CO de 10 dígitos
// empezando en 3 → prepende 57. Si no, deja como llegó. Mismo criterio que
// `process-notifications` para que un mismo teléfono resuelva igual en los
// dos canales.
function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 10 && digits.startsWith("3")) return "57" + digits;
  return digits;
}

// Envío por Twilio. Misma implementación que en `process-notifications`.
async function sendTwilioWhatsApp(toPhone: string, body: string, sid: string, token: string, from: string): Promise<{ ok: boolean; error?: string }> {
  const digits = normalizePhone(toPhone);
  if (!digits) return { ok: false, error: "invalid phone" };
  const formData = new URLSearchParams({
    From: from,
    To: `whatsapp:+${digits}`,
    Body: body,
  });
  const auth = btoa(`${sid}:${token}`);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `twilio ${res.status}: ${errText.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function buildEmailHtml(opts: { teamName: string; inviterName: string; link: string; role: string }) {
  const roleLabel = opts.role === 'lider_equipo' ? 'Líder del equipo' : 'Miembro';
  return `<!doctype html>
<html><body style="font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#fafafa;margin:0;padding:24px;color:#18181b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:18px;overflow:hidden">
<tr><td style="background:linear-gradient(135deg,#7c3aed,#c026d3);color:#fff;padding:18px 24px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:11px">Pro-Gestión · Invitación</td></tr>
<tr><td style="padding:28px 24px">
<p style="font-size:11px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#7c3aed;margin:0 0 8px">Te invitaron a un equipo</p>
<h1 style="font-size:22px;font-weight:900;margin:0 0 8px;color:#18181b">${esc(opts.teamName)}</h1>
<p style="color:#52525b;margin:0 0 20px;font-size:14px">${esc(opts.inviterName)} te invita a unirte como <strong>${esc(roleLabel)}</strong> en Pro-Gestión.</p>
<p style="margin:0 0 20px"><a href="${opts.link}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:12px;font-size:14px">Aceptar invitación</a></p>
<p style="font-size:12px;color:#71717a;margin:0 0 8px">O copia este link en tu navegador:</p>
<p style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#3f3f46;background:#f4f4f5;padding:10px 14px;border-radius:6px;word-break:break-all;margin:0 0 18px">${esc(opts.link)}</p>
<p style="margin:0;font-size:11px;color:#a1a1aa">Esta invitación expira en 14 días. Si no la esperabas, ignorala.</p>
</td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return new Response(JSON.stringify({
      error: (e as Error).message,
      stack: (e as Error).stack?.split("\n").slice(0, 5),
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const body = await req.json().catch(() => ({}));
  const invitationId = body?.invitation_id;
  if (!invitationId) return json({ error: 'invitation_id requerido' }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "pro_gestion" } as any }
  );

  // Leer la invitación.
  const { data: inv, error: errInv } = await supabase
    .from("invitations")
    .select("*")
    .eq("id", invitationId)
    .maybeSingle();
  if (errInv) return json({ error: errInv.message }, 500);
  if (!inv) return json({ error: 'Invitación no encontrada' }, 404);

  // Datos auxiliares para personalizar el mensaje.
  const { data: team } = await supabase.from("teams").select("*").eq("id", inv.team_id).maybeSingle();
  const { data: inviter } = await supabase.from("profiles").select("name, email").eq("id", inv.invited_by).maybeSingle();

  const baseUrl = Deno.env.get("APP_BASE_URL") || req.headers.get('origin') || '';
  if (!baseUrl) {
    return json({ error: 'APP_BASE_URL no configurado y no llegó header Origin' }, 500);
  }
  const link = buildLink(baseUrl, inv.token);

  // ============== ¿Usuario ya registrado? ==============
  // Si el email/teléfono coincide con un profile, el trigger
  // `notify_invitation_event` (mig-30) ya insertó la notif in-app: NO
  // mandamos email/WA externo. Devolvemos channel_status='in_app' para
  // que la UI muestre el mensaje apropiado.
  let existingProfile: { id: string; email: string | null } | null = null;
  if (inv.email) {
    const { data } = await supabase
      .from("profiles")
      .select("id, email")
      .ilike("email", inv.email)
      .limit(1)
      .maybeSingle();
    if (data) existingProfile = data as any;
  }
  if (!existingProfile && inv.phone) {
    // Normalizar phone para match (igual que el trigger).
    const norm = (s: string) => s.replace(/[\s\-+]/g, '');
    const { data: profs } = await supabase.from("profiles").select("id, email, phone").not("phone", "is", null);
    const hit = (profs || []).find((p: any) => p.phone && norm(p.phone) === norm(inv.phone));
    if (hit) existingProfile = { id: hit.id, email: hit.email };
  }

  if (existingProfile) {
    await supabase.from("invitations")
      .update({ status: 'enviada', sent_at: new Date().toISOString() })
      .eq("id", inv.id);
    return json({ ok: true, channel_status: 'in_app', link, profile_id: existingProfile.id });
  }

  // ============== WhatsApp ==============
  if (inv.channel === 'whatsapp') {
    if (!inv.phone) return json({ error: 'Invitación WhatsApp sin destinatario' }, 400);

    const message = `Hola! ${inviter?.name || 'Pancake'} te invitó al equipo "${team?.name || ''}" en Pro-Gestión. Aceptá la invitación acá: ${link}`;
    const markSent = () => supabase
      .from("invitations")
      .update({ status: 'enviada', sent_at: new Date().toISOString() })
      .eq("id", inv.id);

    // 1) API propia de Pancake, si está configurada. Formato esperado:
    //    POST { to, message } con bearer token.
    const waUrl = Deno.env.get("PANCAKE_WA_API_URL");
    const waToken = Deno.env.get("PANCAKE_WA_API_TOKEN");
    if (waUrl && waToken) {
      try {
        const res = await fetch(waUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: inv.phone, message })
        });
        if (!res.ok) throw new Error(`Pancake WA: ${res.status} ${await res.text()}`);
        await markSent();
        return json({ ok: true, channel_status: 'sent', link, via: 'pancake' });
      } catch (e) {
        return json({ ok: false, error: (e as Error).message, link }, 500);
      }
    }

    // 2) Twilio: el canal de WhatsApp que ya usa `process-notifications`.
    //    Con los mismos secrets seteados, las invitaciones salen solas sin
    //    esperar a la API de Pancake.
    const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const twilioFrom = Deno.env.get("TWILIO_WHATSAPP_FROM");
    if (twilioSid && twilioToken && twilioFrom) {
      const r = await sendTwilioWhatsApp(inv.phone, message, twilioSid, twilioToken, twilioFrom);
      if (r.ok) {
        await markSent();
        return json({ ok: true, channel_status: 'sent', link, via: 'twilio' });
      }
      return json({ ok: false, error: r.error, link }, 500);
    }

    // 3) Sin ningún canal configurado: marcamos como pendiente y devolvemos
    //    el link para envío manual.
    await supabase.from("invitations").update({ status: 'pendiente', sent_at: null }).eq("id", inv.id);
    return json({ ok: true, channel_status: 'pending_api', link, message: 'WhatsApp automático no configurado (ni Pancake ni Twilio). Copia el link y envialo manualmente.' });
  }

  // ============== Email ==============
  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD")?.replace(/\s+/g, "");
  if (!gmailUser || !gmailPass) {
    return json({ error: 'GMAIL_USER o GMAIL_APP_PASSWORD no configurados' }, 500);
  }
  if (!inv.email) return json({ error: 'Invitación email sin destinatario' }, 400);

  const smtp = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: gmailUser, password: gmailPass },
    },
  });

  const subject = `Te invitaron al equipo "${team?.name || 'Pancake'}" en Pro-Gestión`;
  const html = buildEmailHtml({
    teamName: team?.name || 'Pancake',
    inviterName: inviter?.name || inviter?.email || 'Tu equipo',
    link,
    role: inv.role
  });

  try {
    await smtp.send({
      from: `Pro-Gestión · Invitaciones <${gmailUser}>`,
      to: inv.email,
      subject,
      html,
      content: "text/html",
    });
    await supabase.from("invitations").update({ status: 'enviada', sent_at: new Date().toISOString() }).eq("id", inv.id);
  } catch (e) {
    try { await smtp.close(); } catch { /* ignore */ }
    return json({ ok: false, error: (e as Error).message, link }, 500);
  }
  try { await smtp.close(); } catch { /* ignore */ }

  return json({ ok: true, channel_status: 'sent', link });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
