import { useState } from 'react';
import { Mail, MessageCircle, Send, AlertCircle, Copy, Check, Link2, ExternalLink, RotateCcw } from 'lucide-react';
import Modal from './Modal.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast';
import { useT } from '../lib/i18n.jsx';
import { createInvitation, sendInvitation, friendlyDbError } from '../lib/data';

// Modal de invitación a un equipo. Dos formas de invitar:
//
//   1. AUTOMÁTICA ("Enviar automático"): crea la invitación e intenta
//      dispararla por la edge function `invite-user` (Gmail SMTP para email,
//      API de Pancake o Twilio para WhatsApp, o notif in-app si el
//      destinatario ya tiene cuenta). Si la edge function NO está
//      desplegada o falla, la invitación NO se cancela: caemos a modo
//      manual y mostramos el link + mensaje para enviarlo a mano.
//
//   2. MANUAL ("Generar link manual"): crea la invitación sin tocar la edge
//      function y te entrega un mensaje pre-escrito con el link para que lo
//      copies y se lo mandes tú por WhatsApp / correo / donde quieras.
//
// En ambos casos el link `/?invite=<token>` es válido 14 días: quien lo abra
// y se registre queda asignado al equipo automáticamente.
export default function InviteModal({ team, onClose, onSent }) {
  const { profile } = useAuth();
  const { t } = useT();
  const showToast = useToast(s => s.show);
  const [channel, setChannel] = useState('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('miembro');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // { link, message, channelStatus, channel, email, phone }
  const [copied, setCopied] = useState(null);  // 'link' | 'message' | null

  const validate = () => {
    if (channel === 'email') {
      const v = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { showToast('Email inválido', 'error'); return false; }
    } else if (!phone.trim()) {
      showToast('Teléfono requerido', 'error'); return false;
    }
    return true;
  };

  // autoSend=true → intenta la edge function; false → solo crea + mensaje manual.
  const handleCreate = async (autoSend) => {
    if (!validate()) return;
    setSending(true);
    try {
      const inv = await createInvitation({
        team_id: team.id,
        channel,
        role,
        invited_by: profile.id,
        email: channel === 'email' ? email.trim() : null,
        phone: channel === 'whatsapp' ? phone.trim() : null
      });

      const link = buildInviteLink(inv.token);
      const message = buildMessage({
        inviterName: profile?.name || profile?.email || 'Tu equipo',
        teamName: team.name,
        role,
        link
      });
      let channelStatus = 'manual';

      if (autoSend) {
        try {
          const res = await sendInvitation(inv.id);
          channelStatus = res?.channel_status || 'sent';
          if (channelStatus === 'in_app') {
            showToast('Le llegó la invitación directo a su bandeja de notificaciones', 'success');
          } else if (channelStatus === 'pending_api') {
            showToast('Invitación creada — copia el mensaje y compártelo (WhatsApp API pendiente)', 'info');
          } else {
            showToast('Invitación enviada', 'success');
          }
        } catch (sendErr) {
          // La edge function no está disponible o falló: NO cancelamos la
          // invitación (sigue siendo válida). Caemos a modo manual.
          channelStatus = 'manual_fallback';
          showToast('No se pudo enviar en automático. Copia el mensaje y envíalo tú.', 'info');
        }
      } else {
        showToast('Invitación lista — copia el mensaje y compártelo', 'success');
      }

      setResult({ link, message, channelStatus, channel, email: inv.email, phone: inv.phone });
      onSent?.();
    } catch (e) {
      const fe = friendlyDbError(e);
      const friendly = (fe.key && t(fe.key)) || fe.raw || e?.message || 'No se pudo crear la invitación';
      showToast('Error: ' + friendly, 'error');
    } finally {
      setSending(false);
    }
  };

  const copy = async (kind, value) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      showToast('No se pudo copiar', 'error');
    }
  };

  const reset = () => {
    setResult(null);
    setCopied(null);
    setEmail('');
    setPhone('');
  };

  const waHref = result?.phone
    ? `https://wa.me/${result.phone.replace(/\D/g, '')}?text=${encodeURIComponent(result.message)}`
    : null;
  const mailHref = result?.email
    ? `mailto:${result.email}?subject=${encodeURIComponent(`Invitación a ${team.name} · Pro-Gestión`)}&body=${encodeURIComponent(result.message)}`
    : null;

  return (
    <Modal title={`Invitar a ${team.name}`} onClose={onClose}
      footer={
        result ? (
          <>
            <button onClick={reset} className="btn-ghost">
              <RotateCcw className="w-3.5 h-3.5" /> Nueva invitación
            </button>
            <button onClick={onClose} className="btn-primary">Listo</button>
          </>
        ) : (
          <>
            <button onClick={onClose} className="btn-ghost">Cerrar</button>
            <button onClick={() => handleCreate(false)} disabled={sending} className="btn-ghost" title="Crea la invitación y te da el mensaje para enviarlo tú">
              <Link2 className="w-3.5 h-3.5" />
              Generar link manual
            </button>
            <button onClick={() => handleCreate(true)} disabled={sending} className="btn-primary">
              <Send className="w-3.5 h-3.5" />
              {sending ? 'Procesando…' : 'Enviar automático'}
            </button>
          </>
        )
      }
    >
      <div className="space-y-5">
        {!result && (
          <>
            <div>
              <label className="text-[10px] font-black text-ink-500 uppercase tracking-widest block mb-2">Canal</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setChannel('email')}
                  className={`p-3 rounded-xl border-2 transition flex items-center gap-2 ${channel === 'email' ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-ink-200 text-ink-600 hover:border-ink-300'}`}
                >
                  <Mail className="w-4 h-4" />
                  <span className="text-sm font-bold">Email</span>
                </button>
                <button
                  type="button"
                  onClick={() => setChannel('whatsapp')}
                  className={`p-3 rounded-xl border-2 transition flex items-center gap-2 ${channel === 'whatsapp' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-ink-200 text-ink-600 hover:border-ink-300'}`}
                >
                  <MessageCircle className="w-4 h-4" />
                  <span className="text-sm font-bold">WhatsApp</span>
                </button>
              </div>
              <div className="mt-2 flex items-start gap-2 text-[11px] text-ink-500 bg-ink-50 border border-ink-200 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span><b>Enviar automático</b> intenta mandarlo por {channel === 'email' ? 'correo' : 'WhatsApp'}. Si no está configurado, igual se crea la invitación y te damos el mensaje. <b>Generar link manual</b> solo crea la invitación y te da el mensaje para enviarlo tú.</span>
              </div>
            </div>

            {channel === 'email' ? (
              <div>
                <label className="text-[10px] font-black text-ink-500 uppercase tracking-widest block mb-2">Email destinatario</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="nombre@dominio.com"
                  className="input-light"
                  autoFocus
                />
              </div>
            ) : (
              <div>
                <label className="text-[10px] font-black text-ink-500 uppercase tracking-widest block mb-2">Teléfono (con código país)</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="+57 300 000 0000"
                  className="input-light"
                  autoFocus
                />
              </div>
            )}

            <div>
              <label className="text-[10px] font-black text-ink-500 uppercase tracking-widest block mb-2">Rol al unirse</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setRole('miembro')}
                  className={`p-3 rounded-xl border-2 transition text-left ${role === 'miembro' ? 'border-violet-500 bg-violet-50' : 'border-ink-200 hover:border-ink-300'}`}
                >
                  <div className="text-sm font-black text-ink-900">Miembro</div>
                  <div className="text-[10px] text-ink-500 mt-0.5">Trabaja dentro del equipo.</div>
                </button>
                <button
                  type="button"
                  onClick={() => setRole('lider_equipo')}
                  className={`p-3 rounded-xl border-2 transition text-left ${role === 'lider_equipo' ? 'border-amber-500 bg-amber-50' : 'border-ink-200 hover:border-ink-300'}`}
                  disabled={!!team.leader_id}
                >
                  <div className="text-sm font-black text-ink-900">Líder del equipo</div>
                  <div className="text-[10px] text-ink-500 mt-0.5">{team.leader_id ? 'Ya hay un líder asignado.' : 'Gestiona el equipo y sus proyectos.'}</div>
                </button>
              </div>
            </div>
          </>
        )}

        {result && (
          <div className="space-y-4">
            <div className={`flex items-start gap-2 text-[12px] rounded-lg px-3 py-2.5 border ${
              result.channelStatus === 'sent' || result.channelStatus === 'in_app'
                ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : 'text-amber-700 bg-amber-50 border-amber-200'
            }`}>
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                {result.channelStatus === 'in_app' && 'El destinatario ya tiene cuenta: le llegó la invitación a sus notificaciones. Igual puedes compartirle el mensaje de abajo.'}
                {result.channelStatus === 'sent' && 'Invitación enviada automáticamente. Si quieres reforzar, comparte el mensaje de abajo.'}
                {result.channelStatus === 'manual_fallback' && 'No se pudo enviar en automático, pero la invitación quedó creada y válida. Copia el mensaje y envíaselo tú.'}
                {result.channelStatus === 'pending_api' && 'WhatsApp automático aún no está configurado. La invitación quedó creada: copia el mensaje y envíaselo tú.'}
                {result.channelStatus === 'manual' && 'Invitación creada. Copia el mensaje y envíaselo por donde prefieras.'}
              </span>
            </div>

            {/* Mensaje listo para enviar */}
            <div className="rounded-xl border border-ink-200 bg-ink-50 px-3 py-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-black text-ink-500 uppercase tracking-widest">Mensaje para enviar</div>
                <button onClick={() => copy('message', result.message)} className="btn-ghost-sm" title="Copiar mensaje">
                  {copied === 'message' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span className="text-[11px] font-bold">{copied === 'message' ? 'Copiado' : 'Copiar'}</span>
                </button>
              </div>
              <textarea
                readOnly
                value={result.message}
                rows={5}
                className="w-full input-light !text-xs resize-none"
                onFocus={e => e.target.select()}
              />
            </div>

            {/* Solo el link */}
            <div className="rounded-xl border border-ink-200 bg-ink-50 px-3 py-3">
              <div className="text-[10px] font-black text-ink-500 uppercase tracking-widest mb-1.5">Solo el link</div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={result.link}
                  className="flex-1 input-light !py-1.5 !text-xs font-mono"
                  onFocus={e => e.target.select()}
                />
                <button onClick={() => copy('link', result.link)} className="btn-ghost-sm" title="Copiar link">
                  {copied === 'link' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[10px] text-ink-500 mt-2">Válido por 14 días. Quien lo abra y se registre quedará asignado al equipo automáticamente.</p>
            </div>

            {/* Atajos para abrir el canal */}
            {(waHref || mailHref) && (
              <div className="flex gap-2">
                {waHref && (
                  <a href={waHref} target="_blank" rel="noreferrer" className="btn-ghost flex-1 justify-center !text-emerald-700 !border-emerald-200 hover:!bg-emerald-50">
                    <MessageCircle className="w-3.5 h-3.5" /> Abrir WhatsApp <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {mailHref && (
                  <a href={mailHref} className="btn-ghost flex-1 justify-center !text-violet-700 !border-violet-200 hover:!bg-violet-50">
                    <Mail className="w-3.5 h-3.5" /> Abrir correo <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function buildInviteLink(token) {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/?invite=${token}`;
}

function buildMessage({ inviterName, teamName, role, link }) {
  const roleLabel = role === 'lider_equipo' ? 'líder del equipo' : 'miembro';
  return `¡Hola! ${inviterName} te invitó a unirte al equipo "${teamName}" en Pro-Gestión como ${roleLabel}.\n\nEntra a este link para aceptar la invitación y crear tu cuenta:\n${link}\n\nEl link es válido por 14 días. Si ya tienes cuenta, también te aparecerá la invitación en tus notificaciones. 🥞`;
}
