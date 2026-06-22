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
