const LOGO_BASE_CANDIDATES = [
  'https://app.voxfree.com.br/assets/upload/',
  'https://app.voxfree.com/assets/upload/',
];

const DEFAULT_LOGO_FILE = 'Voxfree_logo.png';

export function extractLogoCandidate(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';

  // Se vier HTML <img src="...">
  const imgMatch = value.match(/src=["']([^"']+)["']/i);
  if (imgMatch?.[1]) value = imgMatch[1].trim();

  value = value
    .replace(/&amp;/g, '&')
    .replace(/\\+/g, '')
    .trim();

  return value;
}

export function normalizeLogoUrl(raw) {
  let value = extractLogoCandidate(raw);
  if (!value) return '';
  if (value.startsWith('data:image/')) return value;

  // caminho relativo
  if (value.startsWith('//')) value = `https:${value}`;
  if (value.startsWith('/')) value = `https://app.voxfree.com.br${value}`;
  if (!/^https?:\/\//i.test(value) && /voxfree|assets\/upload/i.test(value)) {
    value = `https://${value.replace(/^\/+/, '')}`;
  }

  // Directory list (causa HTTP 403) → completa com arquivo padrão
  if (/\/assets\/upload\/?$/i.test(value)) {
    value = `${value.replace(/\/?$/, '/')}${DEFAULT_LOGO_FILE}`;
  }

  // Sem filename no final
  if (/\/$/.test(value)) {
    return '';
  }

  // Sem extensão de imagem conhecida, mas termina em upload/<algo>
  // deixa passar; o downloader valida.

  return value;
}

export function buildLogoUrlFallbacks(raw) {
  const primary = normalizeLogoUrl(raw);
  const list = [];
  const push = (u) => {
    const n = normalizeLogoUrl(u);
    if (n && !list.includes(n)) list.push(n);
  };

  push(primary);

  // Alterna .com <-> .com.br
  if (primary.includes('://app.voxfree.com/')) {
    push(primary.replace('://app.voxfree.com/', '://app.voxfree.com.br/'));
  }
  if (primary.includes('://app.voxfree.com.br/')) {
    push(primary.replace('://app.voxfree.com.br/', '://app.voxfree.com/'));
  }

  // Fallbacks absolutos conhecidos
  for (const base of LOGO_BASE_CANDIDATES) {
    push(`${base}${DEFAULT_LOGO_FILE}`);
  }

  return list;
}

export function pickLogoUrlsFromAuthData(data = {}) {
  return {
    titulo: normalizeLogoUrl(data.titulo_webphone),
    webphone: normalizeLogoUrl(data.logo_webphone || data.logo_reduzido || data.titulo_webphone),
    raw: {
      titulo_webphone: data.titulo_webphone || '',
      logo_webphone: data.logo_webphone || '',
      logo_reduzido: data.logo_reduzido || '',
    },
  };
}
