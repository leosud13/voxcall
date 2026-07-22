import { md5 } from './md5.js';
import { dialLog, dialError } from './debug.js';

export const VOX_AUTH_URL = 'https://app.voxfree.com.br/webservice/authentication.php';

function normalizePasswordHash(plainPassword, passwordMd5 = null) {
  const preset = passwordMd5 ? String(passwordMd5).trim().toLowerCase() : '';
  if (preset) return preset;

  const plain = String(plainPassword ?? '');
  if (!plain) throw new Error('Informe a senha.');

  // Permite colar o hash MD5 já gerado (32 hex), se necessário.
  if (/^[a-f0-9]{32}$/i.test(plain.trim())) {
    return plain.trim().toLowerCase();
  }

  return md5(plain);
}

export function mapAuthDataToSipConfig(data = {}) {
  const domain = String(data.domnioWebrtc || '').trim();
  const port = String(data.portaWebrtc || '').trim();
  const username = String(data.username || data.authID || '').trim();
  const password = String(data.password || '').trim();

  if (!domain || !port || !username || !password) {
    throw new Error('Resposta da API incompleta para registro WebRTC.');
  }

  const websocketUrl = `wss://${domain}:${port}/ws`;
  const sipUri = `sip:${username}@${domain}`;

  return {
    domain,
    websocketUrl,
    sipUri,
    extension: String(data.label || username).trim(),
    displayName: String(data.displayName || data.label || username).trim(),
    password,
    stunUrl: '',
  };
}

export function mapAuthDataToToggles(data = {}, current = {}) {
  const autoAnswerLocked = data.autoAnswer === 'all';
  return {
    ...current,
    autoAnswer: autoAnswerLocked ? true : (current.autoAnswer ?? false),
    autoAnswerLocked,
    autoRecord: current.autoRecord ?? false,
    callWaiting: String(data.callWaiting) === '1',
  };
}

export async function authenticateVoxfree(username, plainPassword, passwordMd5 = null) {
  const user = String(username || '').trim();
  if (!user) throw new Error('Informe o usuário.');

  const hash = normalizePasswordHash(plainPassword, passwordMd5);
  const params = new URLSearchParams({ username: user, password: hash });
  const requestUrl = `${VOX_AUTH_URL}?${params.toString()}`;

  dialLog('Autenticando na voxfree', { username: user, passwordLength: hash.length });

  let response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: params.toString(),
    });
  } catch (err) {
    dialError('Falha de rede na autenticação', err);
    throw new Error('Não foi possível conectar ao servidor voxfree.');
  }

  if (!response.ok) {
    throw new Error(`Erro HTTP ${response.status} ao autenticar.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Resposta inválida do servidor de autenticação.');
  }

  dialLog('Resposta autenticação', {
    error: payload?.error,
    message: payload?.message || '',
    hasData: !!payload?.data,
  });

  if (Number(payload.error) !== 0) {
    throw new Error(payload.message || 'Usuário ou senha inválido.');
  }

  if (!payload.data) {
    throw new Error('Resposta da API sem dados do ramal.');
  }

  return payload;
}
