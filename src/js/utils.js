const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}(?:[-.\s]?\d{1,6})?/;

export function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d+]/g, '').replace(/^00/, '+');
}

export function isValidPhone(raw) {
  const n = normalizePhone(raw);
  const digits = n.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

/** Aceita ramais SIP curtos (ex.: 1001) e números completos. */
export function isDialableNumber(raw) {
  if (!raw || !String(raw).trim()) return false;
  const value = String(raw).trim();
  if (value.toLowerCase().startsWith('sip:')) return true;
  const digits = normalizePhone(value).replace(/\D/g, '');
  return digits.length >= 3 && digits.length <= 15;
}

export function extractSipDomain(sipUriOrDomain = '') {
  const value = String(sipUriOrDomain).trim();
  if (!value) return '';
  if (!value.includes('@')) return value.replace(/^sip:/i, '');
  const match = value.match(/@([^>;?]+)/);
  return match ? match[1] : '';
}

export function buildSipUri(config = {}) {
  const explicit = String(config.sipUri || '').trim();
  if (explicit) {
    return explicit.startsWith('sip:') ? explicit : `sip:${explicit}`;
  }
  const extension = String(config.extension || '').trim();
  const domain = String(config.domain || '').trim();
  if (extension && domain) return `sip:${extension}@${domain}`;
  return '';
}

export function buildCallUri(target, domain) {
  const value = String(target || '').trim();
  if (!value) throw new Error('Informe o número ou ramal.');
  if (value.toLowerCase().startsWith('sip:')) return value;
  if (value.includes('@')) return `sip:${value.replace(/^sip:/i, '')}`;
  const sipDomain = String(domain || '').trim();
  if (!sipDomain) throw new Error('Domínio SIP não configurado.');
  return `sip:${normalizePhone(value)}@${sipDomain}`;
}

export function formatPhoneDisplay(raw) {
  const n = normalizePhone(raw);
  if (n.length <= 4) return n;
  if (n.startsWith('+')) {
    return `+${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`.trim();
  }
  return n.replace(/(\d{2})(\d{4,5})(\d{4})/, '($1) $2-$3');
}

export function detectPhoneInText(text) {
  const matches = text.match(new RegExp(PHONE_PATTERN.source, 'g'));
  if (!matches) return [];
  return [...new Set(matches.filter(isValidPhone))];
}

export function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
