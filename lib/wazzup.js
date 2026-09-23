// Wazzup24 message sender. Same call WazzOCR makes:
//   POST https://api.wazzup24.com/v3/message
//   Authorization: Bearer <apiKey>
//   { channelId, chatId, chatType: 'whatsapp', text }
//
// Bills Hub uses its own channel, which is safe — unlike the Xero grant, a
// Wazzup channel is not a single-use credential, so both apps can send.

const ENDPOINT = 'https://api.wazzup24.com/v3/message';

// Wazzup wants digits only, with the country code and no leading +.
// "+60 12-345 6789" -> "60123456789"
function normalisePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  // A Malaysian number typed as 012-345 6789 is missing its country code.
  if (digits.startsWith('0')) return '60' + digits.slice(1);
  return digits;
}

// "+60 12-345 6789" for a mobile, "+60 3-8681 7304" for a landline.
// Malaysian mobiles are 1x after the country code; landline area codes are a
// single digit (3 = Klang Valley), which is why the split differs.
function formatPhone(value) {
  const d = normalisePhone(value);
  if (!d) return '';
  if (!d.startsWith('60') || d.length < 10) return `+${d}`;

  const rest = d.slice(2);
  if (rest.startsWith('1')) {
    const prefix = rest.slice(0, 2);
    const body = rest.slice(2);
    return `+60 ${prefix}-${body.slice(0, 3)} ${body.slice(3)}`.trim();
  }
  const area = rest.slice(0, 1);
  const body = rest.slice(1);
  return `+60 ${area}-${body.slice(0, 4)} ${body.slice(4)}`.trim();
}

// Sends one WhatsApp text. Returns { ok, error? } rather than throwing, so one
// bad number cannot stop the rest of a digest run.
async function sendMessage({ channelId, apiKey, phone, text, chatType = 'whatsapp' }) {
  if (!channelId || !apiKey) return { ok: false, error: 'Wazzup channel is not configured.' };
  const chatId = normalisePhone(phone);
  if (!chatId) return { ok: false, error: 'No WhatsApp number.' };
  if (!text || !text.trim()) return { ok: false, error: 'Nothing to send.' };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ channelId, chatId, chatType, text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Wazzup returned HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const payload = await res.json().catch(() => ({}));
    return { ok: true, messageId: payload?.messageId || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendMessage, normalisePhone, formatPhone, ENDPOINT };
