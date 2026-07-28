import { sipClient, CallState } from './sip-client.js';
import { storage } from './storage.js';
import { contactsManager } from './contacts.js';
import {
  formatPhoneDisplay, formatDuration, formatDateTime,
  normalizePhone, isValidPhone, isDialableNumber, generateId,
} from './utils.js';
import { dialLog, dialError, dialGroup } from './debug.js';
import { authenticateVoxfree, mapAuthDataToSipConfig, mapAuthDataToToggles } from './vox-auth.js';
import { md5 } from './md5.js';
import { dialTone } from './dial-tone.js';
import { buildLogoUrlFallbacks, pickLogoUrlsFromAuthData } from './logo-utils.js';

// ─── State ───────────────────────────────────────────────────────────────────
let currentView = 'dialpad';
let dialBuffer = '';
let callTimer = null;
let callSeconds = 0;
let isMuted = false;
let isHeld = false;
let incomingInfo = null;
let micTestCleanup = null;
let appData = {};
let callAnswered = false;
let callRejectedByUser = false;
let latencyTimer = null;
let latencyInFlight = false;

const HISTORY_STATUS_LABELS = {
  missed: 'Perdida',
  answered: 'Atendida',
  ended: 'Finalizada',
  calling: 'Chamando',
  ringing: 'Tocando',
  rejected: 'Recusada',
  failed: 'Falhou',
};

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  appData = await storage.getAll();
  applyTheme(appData.theme || 'dark');
  await contactsManager.load();
  bindNavigation();
  bindSidebar();
  bindLogin();
  bindDialpad();
  bindCallControls();
  bindSettings();
  bindContacts();
  bindHistory();
  bindMissedBanner();
  bindTransfer();
  bindUpdater();
  bindSipEvents();
  renderStatus();
  renderContacts();
  renderHistory();
  updateMissedAlert();
  updateDiagnostics();
  updateAccountSection();

  const auth = appData.auth || {};

  // Conta manual (legado): conecta com SIP local, sem API
  if (auth.manual === true) {
    showApp();
    if (appData.sip?.websocketUrl) await tryConnect();
    return;
  }

  // Sempre revalida no endpoint na inicialização (credenciais / config do ramal)
  if (auth.username && auth.passwordMd5) {
    showLogin();
    prefillLoginForm();
    await revalidateSessionOnStartup();
    return;
  }

  // Sem senha salva: exige login (mesmo se havia sessão antiga)
  if (auth.loggedIn) {
    const cleared = { ...auth, loggedIn: false };
    await storage.setAuth(cleared);
    appData.auth = cleared;
  }

  showLogin();
  prefillLoginForm();
}

// ─── Theme & Logo ────────────────────────────────────────────────────────────
function setImageSrc(el, src) {
  if (!el) return;
  if (!src) {
    el.removeAttribute('src');
    el.hidden = true;
    return;
  }

  const value = String(src).trim();
  el.hidden = true;
  el.onload = () => {
    el.hidden = false;
  };
  el.onerror = () => {
    dialError('Falha ao carregar imagem do logo', {
      preview: value.slice(0, 48),
      length: value.length,
      kind: value.startsWith('data:') ? 'data' : (value.startsWith('http') ? 'http' : 'other'),
    });
    el.hidden = true;
  };

  // força reload mesmo se a URL for igual
  el.removeAttribute('src');
  el.src = value;
}

function applyLogo() {
  const logos = appData.brandLogos || {};
  const loggedIn = isApiAuthenticated();

  dialLog('Aplicando logos', {
    loggedIn,
    tituloLen: logos.titulo ? String(logos.titulo).length : 0,
    webphoneLen: logos.webphone ? String(logos.webphone).length : 0,
    tituloKind: logos.titulo?.startsWith?.('data:') ? 'data' : (logos.titulo?.startsWith?.('http') ? 'http' : 'empty'),
    webphoneKind: logos.webphone?.startsWith?.('data:') ? 'data' : (logos.webphone?.startsWith?.('http') ? 'http' : 'empty'),
  });

  setImageSrc($('#logo-image'), loggedIn ? (logos.webphone || '') : '');
  setImageSrc($('#login-logo'), logos.titulo || '');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️ Claro' : '🌙 Escuro';
  applyLogo();
}

async function fetchLogoAsDataUrl(urlOrList, key) {
  const list = (Array.isArray(urlOrList) ? urlOrList : [urlOrList])
    .flatMap((item) => buildLogoUrlFallbacks(item))
    .filter(Boolean);

  // unique
  const urls = [...new Set(list)];
  if (!urls.length) return '';

  if (urls[0].startsWith('data:image/')) return urls[0];

  try {
    if (window.voxcall?.logo?.fetch) {
      const result = await window.voxcall.logo.fetch(urls, key);
      if (result && String(result).startsWith('data:image/')) return result;
    }
  } catch (err) {
    dialError('logo.fetch IPC falhou', err);
  }

  return '';
}

async function saveBrandLogosFromApi(data = {}) {
  const picked = pickLogoUrlsFromAuthData(data);

  dialLog('Logos recebidas da API', {
    raw: picked.raw,
    tituloNormalizado: picked.titulo,
    webphoneNormalizado: picked.webphone,
    keys: Object.keys(data || {}),
  });

  const [tituloCached, webphoneCached] = await Promise.all([
    fetchLogoAsDataUrl([data.titulo_webphone, picked.titulo], 'titulo'),
    fetchLogoAsDataUrl(
      [data.logo_webphone, data.logo_reduzido, data.titulo_webphone, picked.webphone],
      'webphone',
    ),
  ]);

  const brandLogos = {
    titulo: tituloCached || '',
    webphone: webphoneCached || tituloCached || '',
  };

  appData.brandLogos = brandLogos;
  await storage.setBrandLogos(brandLogos);
  applyLogo();

  dialLog('Logos salvas', {
    tituloOk: brandLogos.titulo.startsWith('data:image/'),
    webphoneOk: brandLogos.webphone.startsWith('data:image/'),
  });
}

async function clearBrandLogos() {
  const empty = { titulo: '', webphone: '' };
  await storage.setBrandLogos(empty);
  appData.brandLogos = empty;
  applyLogo();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function toggleTheme() {
  const next = appData.theme === 'dark' ? 'light' : 'dark';
  appData.theme = next;
  await storage.setTheme(next);
  applyTheme(next);
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function isSidebarOpen() {
  return Boolean($('#app')?.classList.contains('sidebar-open'));
}

function shouldShowBackButton() {
  return isSidebarOpen() || currentView !== 'dialpad';
}

function updateSidebarToggleUi() {
  const btn = $('#sidebar-toggle');
  const app = $('#app');
  if (!btn || !app) return;

  const showBack = shouldShowBackButton();
  app.classList.toggle('showing-back', showBack);
  btn.setAttribute('aria-label', showBack ? 'Voltar' : 'Abrir menu');
  btn.title = showBack ? 'Voltar' : 'Menu';
}

function openSidebar() {
  $('#app')?.classList.add('sidebar-open');
  const backdrop = $('#sidebar-backdrop');
  if (backdrop) backdrop.hidden = false;
  updateSidebarToggleUi();
}

function closeSidebar() {
  $('#app')?.classList.remove('sidebar-open');
  const backdrop = $('#sidebar-backdrop');
  if (backdrop) backdrop.hidden = true;
  updateSidebarToggleUi();
}

function toggleSidebar() {
  if (isSidebarOpen()) {
    closeSidebar();
    return;
  }
  if (currentView !== 'dialpad') {
    switchView('dialpad');
    return;
  }
  openSidebar();
}

function bindSidebar() {
  $('#sidebar-toggle')?.addEventListener('click', toggleSidebar);
  $('#sidebar-backdrop')?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
  });
  updateSidebarToggleUi();
}

// ─── Auto Update ─────────────────────────────────────────────────────────────
function setUpdateBannerVisible(visible) {
  document.body.classList.toggle('has-update-banner', visible);
  const banner = $('#update-banner');
  if (banner) banner.hidden = !visible;
}

function handleUpdaterStatus(payload = {}) {
  const { state, version, percent, message } = payload;
  const statusEl = $('#update-status');
  const bannerText = $('#update-banner-text');
  const installBtn = $('#btn-install-update');

  switch (state) {
    case 'dev':
      if (statusEl) statusEl.textContent = 'Atualizações automáticas disponíveis apenas na versão instalada.';
      setUpdateBannerVisible(false);
      break;
    case 'checking':
      if (statusEl) statusEl.textContent = 'Verificando atualizações...';
      setUpdateBannerVisible(true);
      if (bannerText) bannerText.textContent = 'Verificando atualizações...';
      if (installBtn) installBtn.hidden = true;
      break;
    case 'available':
      if (statusEl) statusEl.textContent = `Nova versão ${version} encontrada. Baixando...`;
      setUpdateBannerVisible(true);
      if (bannerText) bannerText.textContent = `Nova versão ${version} encontrada. Baixando...`;
      if (installBtn) installBtn.hidden = true;
      showToast(`Nova versão ${version} disponível`, 'info');
      break;
    case 'downloading':
      if (statusEl) statusEl.textContent = `Baixando atualização... ${percent || 0}%`;
      setUpdateBannerVisible(true);
      if (bannerText) bannerText.textContent = `Baixando atualização... ${percent || 0}%`;
      if (installBtn) installBtn.hidden = true;
      break;
    case 'downloaded':
      if (statusEl) statusEl.textContent = `Versão ${version} pronta para instalar.`;
      setUpdateBannerVisible(true);
      if (bannerText) bannerText.textContent = `Versão ${version} pronta. Reinicie para atualizar.`;
      if (installBtn) installBtn.hidden = false;
      showToast('Atualização baixada. Reinicie para instalar.', 'success');
      break;
    case 'not-available':
      if (statusEl) statusEl.textContent = 'Você já está na versão mais recente.';
      setUpdateBannerVisible(false);
      showToast('Você já está na versão mais recente.', 'info');
      break;
    case 'error':
      if (statusEl) statusEl.textContent = message || 'Não foi possível verificar atualizações.';
      setUpdateBannerVisible(false);
      showToast(message || 'Não foi possível verificar atualizações.', 'error');
      break;
    default:
      break;
  }
}

async function bindUpdater() {
  const version = await window.voxcall?.app?.getVersion?.();
  const versionLabel = version ? `v${version}` : 'v—';
  const versionEl = $('#app-version');
  if (versionEl) versionEl.textContent = version || '—';
  const badge = $('#app-version-badge');
  if (badge) badge.textContent = versionLabel;

  window.voxcall?.updater?.onStatus?.(handleUpdaterStatus);

  $('#btn-check-update')?.addEventListener('click', async () => {
    const result = await window.voxcall?.updater?.check?.();
    if (result?.skipped) {
      showToast('Atualizações automáticas só funcionam na versão instalada', 'info');
      handleUpdaterStatus({ state: 'dev' });
    }
  });

  $('#btn-install-update')?.addEventListener('click', () => {
    window.voxcall?.updater?.install?.();
  });
}

// ─── Login ───────────────────────────────────────────────────────────────────
function isApiAuthenticated() {
  const auth = appData.auth || {};
  return auth.loggedIn === true && !!auth.username && auth.manual !== true;
}

function shouldShowLogin() {
  return !isApiAuthenticated();
}

function showLogin() {
  document.body.classList.add('login-active');
  $('#login-error')?.setAttribute('hidden', '');
}

function showApp() {
  document.body.classList.remove('login-active');
  switchView('dialpad');
}

function prefillLoginForm() {
  const auth = appData.auth || {};
  if (auth.username) $('#login-username').value = auth.username;
  if ($('#login-remember')) $('#login-remember').checked = !!auth.remember;
}

function setLoginLoading(loading) {
  const btn = $('#btn-login');
  const form = $('#login-form');
  if (btn) {
    btn.disabled = loading;
    btn.textContent = loading ? 'Entrando...' : 'Entrar';
  }
  if (form) {
    form.querySelectorAll('input').forEach((input) => { input.disabled = loading; });
  }
}

function showLoginError(message) {
  const errEl = $('#login-error');
  if (!errEl) return;
  if (message) {
    errEl.textContent = message;
    errEl.removeAttribute('hidden');
  } else {
    errEl.textContent = '';
    errEl.setAttribute('hidden', '');
  }
}

async function applyAuthSession(username, passwordMd5, remember, payload, manual = false) {
  const sip = mapAuthDataToSipConfig(payload.data);
  const toggles = mapAuthDataToToggles(payload.data, appData.toggles || {});

  const auth = {
    loggedIn: true,
    username,
    remember: !!remember,
    passwordMd5: remember ? passwordMd5 : '',
    manual: !!manual,
    displayName: sip.displayName,
    label: String(payload.data?.label || sip.extension || '').trim(),
  };

  await storage.setSip(sip);
  await storage.setToggles(toggles);
  await storage.setAuth(auth);

  appData.sip = sip;
  appData.toggles = toggles;
  appData.auth = auth;

  await saveBrandLogosFromApi(payload.data);
  loadSettingsForm();
  updateAccountSection();
  showApp();
  applyLogo();
  await tryConnect();
  applyLogo();
  return sip;
}

async function revalidateSessionOnStartup() {
  const auth = appData.auth || {};
  const username = String(auth.username || '').trim();
  const passwordMd5 = String(auth.passwordMd5 || '').trim().toLowerCase();

  if (!username || !passwordMd5) {
    showLogin();
    prefillLoginForm();
    return false;
  }

  setLoginLoading(true);
  showLoginError('');
  const btn = $('#btn-login');
  if (btn) btn.textContent = 'Validando...';

  dialLog('Revalidando sessão no endpoint na inicialização', { username });

  try {
    const payload = await authenticateVoxfree(username, null, passwordMd5);
    await applyAuthSession(username, passwordMd5, !!auth.remember, payload, false);
    dialLog('Sessão revalidada com sucesso', {
      extension: appData.sip?.extension,
      domain: appData.sip?.domain,
    });
    return true;
  } catch (e) {
    dialError('Falha ao revalidar sessão na inicialização', e);
    sipClient.disconnect();

    const nextAuth = {
      loggedIn: false,
      username: auth.remember ? username : '',
      passwordMd5: auth.remember ? passwordMd5 : '',
      remember: !!auth.remember,
      manual: false,
      displayName: '',
      label: '',
    };
    await storage.setAuth(nextAuth);
    appData.auth = nextAuth;

    showLogin();
    prefillLoginForm();
    showLoginError(e.message || 'Não foi possível validar a sessão. Faça login novamente.');
    return false;
  } finally {
    setLoginLoading(false);
  }
}

async function performLogin(username, plainPassword, passwordMd5 = null, isAuto = false) {
  setLoginLoading(true);
  showLoginError('');

  try {
    const remember = $('#login-remember')?.checked ?? appData.auth?.remember;
    const hash = passwordMd5
      ? String(passwordMd5).trim().toLowerCase()
      : (/^[a-f0-9]{32}$/i.test(String(plainPassword || '').trim())
        ? String(plainPassword).trim().toLowerCase()
        : md5(plainPassword || ''));
    const payload = await authenticateVoxfree(username, plainPassword, passwordMd5);
    const sip = await applyAuthSession(username, hash, remember, payload, false);

    if (!isAuto) {
      showToast(`Bem-vindo, ${sip.displayName}`, 'success');
    }
  } catch (e) {
    showLogin();
    showLoginError(e.message || 'Falha ao autenticar.');
    if (!isAuto) showToast(e.message || 'Falha ao autenticar.', 'error');
  } finally {
    setLoginLoading(false);
  }
}

async function logout() {
  sipClient.disconnect();
  const remember = !!appData.auth?.remember;
  const auth = {
    loggedIn: false,
    username: remember ? (appData.auth?.username || '') : '',
    passwordMd5: remember ? (appData.auth?.passwordMd5 || '') : '',
    remember,
    manual: false,
    displayName: '',
    label: '',
  };

  await storage.setAuth(auth);
  appData.auth = auth;

  const toggles = {
    ...(appData.toggles || {}),
    autoAnswer: false,
    autoAnswerLocked: false,
  };
  await storage.setToggles(toggles);
  appData.toggles = toggles;
  applyAutoAnswerLockUi();
  applyLogo();

  setStatus('offline', 'Desconectado');
  updateAccountSection();
  showLogin();
  prefillLoginForm();
  showToast('Sessão encerrada', 'info');
}

function updateAccountSection() {
  const section = $('#account-section');
  const auth = appData.auth || {};
  const loggedIn = isApiAuthenticated();

  if (section) section.hidden = !loggedIn;

  const userEl = $('#account-username');
  const extEl = $('#account-extension');
  if (userEl) userEl.textContent = auth.username || '—';
  if (extEl) extEl.textContent = auth.label || appData.sip?.extension || '—';
}

function bindLogin() {
  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username')?.value.trim();
    const password = $('#login-password')?.value || '';
    await performLogin(username, password);
  });

  $('#btn-logout')?.addEventListener('click', logout);
}

// ─── SIP Connection ──────────────────────────────────────────────────────────
async function tryConnect() {
  const brandLogos = appData.brandLogos;
  appData = await storage.getAll();
  if (brandLogos && (brandLogos.webphone || brandLogos.titulo)) {
    appData.brandLogos = brandLogos;
  }
  try {
    await sipClient.connect(appData.sip, appData.toggles);
    setStatus('connecting', 'Conectando...');
  } catch (e) {
    setStatus('error', e.message);
  }
  applyLogo();
}

function bindSipEvents() {
  sipClient.on('state', (s) => {
    if (s.registration === 'registered') setStatus('registered', 'Registrado');
    else if (s.registration === 'registering') setStatus('connecting', 'Registrando...');
    else if (s.registration === 'failed') setStatus('error', `Falha: ${s.cause || ''}`);
    else if (s.registration === 'unregistered') setStatus('offline', 'Desconectado');
    if (s.ws) updateDiagField('ws', s.ws);
    if (s.registration) updateDiagField('reg', s.registration);
  });

  sipClient.on('incoming', (info) => {
    incomingInfo = info;
    callAnswered = false;
    callRejectedByUser = false;
    showIncomingBanner(info);
    addHistoryEntry({ direction: 'incoming', number: info.caller, name: info.display, status: 'ringing' });
    window.voxcall?.call?.notifyIncoming?.({
      caller: info.display && info.display !== info.caller ? info.display : info.caller,
      number: info.caller,
    });
  });

  sipClient.on('outgoing', (info) => {
    dialLog('UI: chamada outgoing', info);
    callAnswered = false;
    callRejectedByUser = false;
    showCallPanel(info.target);
    addHistoryEntry({ direction: 'outgoing', number: info.target, status: 'calling' });
  });

  sipClient.on('callState', ({ state, cause }) => {
    dialLog('UI: callState', { state, cause });
    if (state === CallState.CONNECTED) {
      callAnswered = true;
      hideIncomingBanner();
      window.voxcall?.call?.clearIncoming?.();
      if (incomingInfo) {
        showCallPanel(incomingInfo.display || incomingInfo.caller);
        incomingInfo = null;
      }
      $('#call-status').textContent = 'Em chamada';
      startCallTimer();
      updateHistoryLast('answered');
    } else if (state === CallState.RINGING) {
      $('#call-status').textContent = 'Chamando...';
      // Timer só começa quando a chamada for atendida
      stopCallTimer({ reset: true });
    } else if (state === CallState.HELD) {
      isHeld = true;
      $('#call-status').textContent = 'Em espera';
      const holdLabel = $('#btn-hold')?.querySelector('.btn-call-label');
      if (holdLabel) holdLabel.textContent = 'Retomar';
    }
  });

  sipClient.on('callEnded', () => {
    const endedAnswered = callAnswered;
    const endedRejected = callRejectedByUser;
    const endedDuration = callSeconds;

    // Libera a UI primeiro para não travar a discagem se o histórico falhar/atrasar
    hideCallPanel();
    hideIncomingBanner();
    window.voxcall?.call?.clearIncoming?.();
    stopCallTimer({ reset: true });
    isMuted = false;
    isHeld = false;
    incomingInfo = null;
    callAnswered = false;
    callRejectedByUser = false;

    void (async () => {
      try {
        await finalizeHistoryOnCallEnd({
          answered: endedAnswered,
          rejectedByUser: endedRejected,
          duration: endedDuration,
        });
        if (currentView === 'history') {
          await markMissedAsViewed();
        } else {
          renderHistory();
          updateMissedAlert();
        }
      } catch (e) {
        dialError('Falha ao atualizar histórico após chamada', e);
        renderHistory();
        updateMissedAlert();
      }
    })();
  });

  sipClient.on('callFailed', ({ cause }) => {
    dialError('UI: callFailed', { cause });
    showToast(`Chamada falhou: ${cause || 'erro desconhecido'}`, 'error');
  });

  sipClient.on('hold', ({ held }) => {
    isHeld = held;
    const holdLabel = $('#btn-hold')?.querySelector('.btn-call-label');
    if (holdLabel) holdLabel.textContent = held ? 'Retomar' : 'Espera';
    $('#call-status').textContent = held ? 'Em espera' : 'Em chamada';
  });

  sipClient.on('meters', ({ local, remote }) => {
    setMeter('meter-local', local);
    setMeter('meter-remote', remote);
    $('#meter-local-val').textContent = `${local}%`;
    $('#meter-remote-val').textContent = `${remote}%`;
  });

  sipClient.on('ice', ({ state }) => {
    updateDiagField('ice', state);
  });

  sipClient.on('diagnostics', (d) => {
    renderDiagnostics(d);
  });

  sipClient.on('error', ({ message }) => {
    showToast(message, 'error');
  });
}

// ─── Status bar ──────────────────────────────────────────────────────────────
function getExtensionNumber() {
  return String(appData?.auth?.label || appData?.sip?.extension || '').trim();
}

function formatStatusWithExtension(baseText) {
  const ext = getExtensionNumber();
  return ext ? `${ext} · ${baseText}` : baseText;
}

function getSipLatencyTarget() {
  const raw = String(appData?.sip?.websocketUrl || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    if (!url.hostname || !port) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

function latencyLevel(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms <= 70) return 'good';
  if (ms <= 110) return 'warn';
  return 'bad';
}

function updateLatencyIndicator(ms) {
  const el = $('#latency-indicator');
  const valueEl = $('#latency-value');
  if (!el || !valueEl) return;

  const level = latencyLevel(ms);
  if (!level) {
    el.hidden = true;
    return;
  }

  el.hidden = false;
  el.className = `latency-indicator latency-${level}`;
  el.title = `Latência: ${ms} ms`;
  valueEl.textContent = `${ms} ms`;
}

function hideLatencyIndicator() {
  const el = $('#latency-indicator');
  if (!el) return;
  el.hidden = true;
  el.className = 'latency-indicator';
  const valueEl = $('#latency-value');
  if (valueEl) valueEl.textContent = '— ms';
}

async function refreshLatency() {
  if (latencyInFlight) return;
  if (!window.voxcall?.net?.latency) return;

  const target = getSipLatencyTarget();
  if (!target) {
    hideLatencyIndicator();
    return;
  }

  latencyInFlight = true;
  try {
    const ms = await window.voxcall.net.latency(target.host, target.port);
    updateLatencyIndicator(typeof ms === 'number' ? ms : null);
  } catch {
    hideLatencyIndicator();
  } finally {
    latencyInFlight = false;
  }
}

function startLatencyMonitor() {
  if (latencyTimer) return;
  refreshLatency();
  latencyTimer = setInterval(refreshLatency, 60000);
}

function stopLatencyMonitor() {
  if (latencyTimer) {
    clearInterval(latencyTimer);
    latencyTimer = null;
  }
  hideLatencyIndicator();
}

function updateRegLight(type, text) {
  const light = $('#reg-status-light');
  const textEl = $('#reg-status-text');
  if (!light) return;

  let regType = 'offline';
  let label = 'Sem registro';

  if (type === 'registered') {
    regType = 'registered';
    label = formatStatusWithExtension('Registrado');
    startLatencyMonitor();
  } else if (type === 'connecting') {
    regType = 'registering';
    label = formatStatusWithExtension('Registrando');
    stopLatencyMonitor();
  } else {
    regType = 'offline';
    label = 'Sem registro';
    stopLatencyMonitor();
  }

  light.className = `reg-status-light reg-${regType}`;
  light.title = text || label;
  if (textEl) textEl.textContent = label;
}

function setStatus(type, text) {
  const el = $('#status-badge');
  const display = (type === 'registered' || type === 'connecting')
    ? formatStatusWithExtension(text)
    : text;
  if (el) {
    el.className = `status-badge status-${type}`;
    el.textContent = display;
  }
  updateRegLight(type, display);
}

function renderStatus() {
  const d = sipClient.getDiagnostics();
  if (d.registration === 'registered') {
    setStatus('registered', 'Registrado');
  } else if (d.registration === 'registering') {
    setStatus('connecting', 'Registrando...');
  } else {
    setStatus('offline', 'Sem registro');
  }
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function bindNavigation() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
    });
  });
  $('#theme-toggle')?.addEventListener('click', toggleTheme);
}

function switchView(view) {
  currentView = view;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  closeSidebar();
  updateSidebarToggleUi();
  if (view === 'history') {
    markMissedAsViewed();
  }
}

// ─── Dialpad ─────────────────────────────────────────────────────────────────
function bindDialpad() {
  $$('.dial-key').forEach((key) => {
    key.addEventListener('click', () => appendDial(key.dataset.digit));
  });

  const dialInput = $('#dial-input');
  dialInput?.addEventListener('input', (e) => {
    dialBuffer = e.target.value;
  });
  dialInput?.addEventListener('keydown', (e) => {
    if (/^[0-9*#+]$/.test(e.key)) {
      dialTone.play(e.key);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      dialBuffer = dialInput.value || dialBuffer;
      makeCall(dialBuffer);
    }
  });

  $('#btn-backspace')?.addEventListener('click', () => {
    dialBuffer = dialBuffer.slice(0, -1);
    $('#dial-input').value = dialBuffer;
  });

  $('#btn-clear')?.addEventListener('click', () => {
    dialBuffer = '';
    $('#dial-input').value = '';
  });

  $('#btn-call')?.addEventListener('click', () => {
    dialLog('Botão Ligar clicado', { dialBuffer });
    const inputVal = $('#dial-input')?.value;
    if (inputVal != null) dialBuffer = inputVal;
    makeCall(dialBuffer);
  });

  document.addEventListener('keydown', (e) => {
    if (currentView !== 'dialpad') return;
    if (document.body.classList.contains('login-active')) return;
    if (document.body.classList.contains('in-call')) return;
    if (e.target === dialInput) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (/^[0-9*#+]$/.test(e.key)) {
      appendDial(e.key);
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      dialBuffer = dialBuffer.slice(0, -1);
      $('#dial-input').value = dialBuffer;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      makeCall(dialBuffer);
    }
  });
}

function appendDial(digit) {
  dialTone.play(digit);
  dialBuffer += digit;
  $('#dial-input').value = dialBuffer;
}

async function makeCall(number) {
  const fromInput = $('#dial-input')?.value;
  const target = String(number || fromInput || '').trim();

  dialGroup('DISCAR', () => {
    dialLog('1. Número informado', { target, dialBuffer });

    if (document.body.classList.contains('in-call')) {
      dialError('2. Bloqueado — já em chamada');
      showToast('Já existe uma chamada em andamento', 'error');
      return;
    }

    if (!isDialableNumber(target)) {
      dialError('2. Validação falhou — número/ramal inválido', { target });
      showToast('Número ou ramal inválido', 'error');
      return;
    }

    const diagnostics = sipClient.getDiagnostics();
    dialLog('2. Estado SIP antes da chamada', diagnostics);

    try {
      dialLog('3. Chamando sipClient.call()...');
      const session = sipClient.call(target);
      dialLog('4. sipClient.call() retornou', {
        sessionId: session?.id,
        direction: session?.direction,
      });
      dialBuffer = '';
      $('#dial-input').value = '';
    } catch (e) {
      dialError('4. sipClient.call() lançou erro', e);
      showToast(e.message, 'error');
    }
  });
}

// ─── Call controls ───────────────────────────────────────────────────────────
function answerIncomingCall() {
  const info = incomingInfo;
  hideIncomingBanner();
  window.voxcall?.call?.clearIncoming?.();
  if (info) {
    showCallPanel(info.display || info.caller);
    $('#call-status').textContent = 'Atendendo...';
  }
  sipClient.answer();
}

function rejectIncomingCall() {
  hideIncomingBanner();
  window.voxcall?.call?.clearIncoming?.();
  incomingInfo = null;
  callRejectedByUser = true;
  sipClient.reject();
}

// ─── Call controls ───────────────────────────────────────────────────────────
function bindCallControls() {
  $('#btn-answer')?.addEventListener('click', () => answerIncomingCall());
  $('#btn-reject')?.addEventListener('click', () => rejectIncomingCall());
  $('#btn-hangup')?.addEventListener('click', () => sipClient.hangup());
  window.voxcall?.call?.onAction?.(({ action }) => {
    if (action === 'answer') answerIncomingCall();
    if (action === 'reject') rejectIncomingCall();
  });
  $('#btn-mute')?.addEventListener('click', () => {
    isMuted = !isMuted;
    sipClient.mute(isMuted);
    $('#btn-mute')?.classList.toggle('active', isMuted);
    const muteLabel = $('#btn-mute')?.querySelector('.btn-call-label');
    if (muteLabel) muteLabel.textContent = isMuted ? 'Silenciado' : 'Mudo';
  });
  $('#btn-hold')?.addEventListener('click', () => {
    if (isHeld) sipClient.unhold();
    else sipClient.hold();
  });

  $('#btn-dtmf-toggle')?.addEventListener('click', () => toggleCallExtraPanel('dtmf'));
  $('#btn-transfer-toggle')?.addEventListener('click', () => toggleCallExtraPanel('transfer'));

  $$('.dtmf-key').forEach((key) => {
    key.addEventListener('click', () => {
      dialTone.play(key.dataset.digit);
      sipClient.sendDTMF(key.dataset.digit);
      flashDtmf(key.dataset.digit);
    });
  });
}

function resetCallExtraPanels() {
  $('#dtmf-section')?.setAttribute('hidden', '');
  $('#transfer-section')?.setAttribute('hidden', '');
  $('#btn-dtmf-toggle')?.classList.remove('active');
  $('#btn-transfer-toggle')?.classList.remove('active');
  $('#dtmf-display').textContent = '';
}

function toggleCallExtraPanel(panel) {
  const dtmf = $('#dtmf-section');
  const transfer = $('#transfer-section');
  const dtmfBtn = $('#btn-dtmf-toggle');
  const transferBtn = $('#btn-transfer-toggle');

  if (panel === 'dtmf') {
    const willShow = dtmf?.hasAttribute('hidden');
    resetCallExtraPanels();
    if (willShow) {
      dtmf?.removeAttribute('hidden');
      dtmfBtn?.classList.add('active');
    }
    return;
  }

  if (panel === 'transfer') {
    const willShow = transfer?.hasAttribute('hidden');
    resetCallExtraPanels();
    if (willShow) {
      transfer?.removeAttribute('hidden');
      transferBtn?.classList.add('active');
    }
  }
}

function showCallPanel(number) {
  document.body.classList.add('in-call');
  resetCallExtraPanels();
  $('#call-panel')?.classList.add('visible');
  $('#call-number').textContent = formatPhoneDisplay(number);
  $('#call-status').textContent = 'Chamando...';
  stopCallTimer({ reset: true });
  setMeter('meter-local', 0);
  setMeter('meter-remote', 0);
}

function hideCallPanel() {
  document.body.classList.remove('in-call');
  resetCallExtraPanels();
  $('#call-panel')?.classList.remove('visible');
  $('#btn-mute')?.classList.remove('active');
  const muteLabel = $('#btn-mute')?.querySelector('.btn-call-label');
  if (muteLabel) muteLabel.textContent = 'Mudo';
  const holdLabel = $('#btn-hold')?.querySelector('.btn-call-label');
  if (holdLabel) holdLabel.textContent = 'Espera';
  stopCallTimer({ reset: true });
}

function showIncomingBanner(info) {
  const name = String(info.display || '').trim();
  const number = String(info.caller || '').trim();
  const hasName = name && name !== number;

  $('#incoming-banner').classList.add('visible');
  $('#incoming-caller').textContent = hasName ? name : (number || '—');
  $('#incoming-number').textContent = hasName
    ? formatPhoneDisplay(number)
    : (number ? formatPhoneDisplay(number) : '—');
}

function hideIncomingBanner() {
  $('#incoming-banner').classList.remove('visible');
}

function startCallTimer() {
  // Evita reiniciar o contador se already em andamento (accepted + confirmed)
  if (callTimer) return;
  callSeconds = 0;
  $('#call-timer').textContent = '00:00';
  callTimer = setInterval(() => {
    callSeconds++;
    $('#call-timer').textContent = formatDuration(callSeconds);
  }, 1000);
}

function stopCallTimer({ reset = false } = {}) {
  if (callTimer) {
    clearInterval(callTimer);
    callTimer = null;
  }
  if (reset) {
    callSeconds = 0;
    const el = $('#call-timer');
    if (el) el.textContent = '00:00';
  }
}

function flashDtmf(digit) {
  const el = $('#dtmf-display');
  if (!el) return;
  el.textContent = (el.textContent + digit).slice(-16);
}

function setMeter(id, level) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${level}%`;
}

// ─── Transfer ────────────────────────────────────────────────────────────────
function bindTransfer() {
  $('#btn-blind-transfer')?.addEventListener('click', async () => {
    const target = $('#transfer-target')?.value?.trim();
    if (!target) return showToast('Informe o destino', 'error');
    try {
      sipClient.blindTransfer(target);
      showToast(`Transferência cega para ${target}`, 'info');
    } catch (e) { showToast(e.message, 'error'); }
  });

  $('#btn-consult')?.addEventListener('click', async () => {
    const target = $('#transfer-target')?.value?.trim();
    if (!target) return showToast('Informe o destino', 'error');
    try {
      sipClient.startConsultation(target);
      $('#consult-panel').classList.add('visible');
      showToast(`Consultando ${target}...`, 'info');
    } catch (e) { showToast(e.message, 'error'); }
  });

  $('#btn-complete-transfer')?.addEventListener('click', () => {
    try {
      sipClient.completeAttendedTransfer();
      $('#consult-panel').classList.remove('visible');
      showToast('Transferência assistida concluída', 'info');
    } catch (e) { showToast(e.message, 'error'); }
  });

  $('#btn-cancel-consult')?.addEventListener('click', () => {
    sipClient.cancelConsultation();
    $('#consult-panel').classList.remove('visible');
  });

  $('#btn-swap')?.addEventListener('click', () => sipClient.swapToConsult());
}

// ─── Settings ────────────────────────────────────────────────────────────────
function isAutoAnswerLocked() {
  return !!appData.toggles?.autoAnswerLocked;
}

function applyAutoAnswerLockUi() {
  const input = $('#toggle-auto-answer');
  const label = $('#toggle-auto-answer-label');
  const hint = $('#auto-answer-admin-hint');
  const locked = isAutoAnswerLocked();
  const message = 'O Administrador definiu que o atendimento é automático.';

  if (input) {
    input.checked = locked ? true : !!appData.toggles?.autoAnswer;
    input.disabled = locked;
    input.title = locked ? message : '';
  }
  if (label) {
    label.classList.toggle('is-locked', locked);
    label.title = locked ? message : '';
  }
  if (hint) {
    hint.hidden = !locked;
    hint.title = message;
  }
}

function bindSettings() {
  loadSettingsForm();

  $$('.toggle-input').forEach((input) => {
    input.addEventListener('change', async () => {
      if (input.id === 'toggle-auto-answer' && isAutoAnswerLocked()) {
        input.checked = true;
        showToast('O Administrador definiu que o atendimento é automático.', 'info');
        return;
      }

      if (input.id === 'toggle-auto-launch') {
        const enabled = input.checked;
        await window.voxcall?.app?.setAutoLaunch?.(enabled);
        appData.autoLaunch = enabled;
        showToast(enabled ? 'VoxCall iniciará com o Windows' : 'Inicialização automática desativada', 'success');
        return;
      }

      const toggles = {
        autoAnswer: isAutoAnswerLocked() ? true : $('#toggle-auto-answer').checked,
        autoAnswerLocked: isAutoAnswerLocked(),
        autoRecord: $('#toggle-auto-record').checked,
        callWaiting: $('#toggle-call-waiting').checked,
      };
      await storage.setToggles(toggles);
      appData.toggles = toggles;
      sipClient.toggles = { ...sipClient.toggles, ...toggles };
      showToast('Preferências atualizadas', 'success');
    });
  });

  $('#btn-test-mic')?.addEventListener('click', async () => {
    if (micTestCleanup) {
      micTestCleanup();
      micTestCleanup = null;
      $('#btn-test-mic').textContent = '🎤 Testar Microfone';
      return;
    }
    $('#btn-test-mic').textContent = '⏹ Parar Teste';
    micTestCleanup = await sipClient.testMicrophone((level) => {
      setMeter('meter-test-mic', level);
      $('#meter-test-mic-val').textContent = `${level}%`;
    });
  });

  $('#btn-test-speaker')?.addEventListener('click', () => {
    sipClient.testSpeaker();
    showToast('Reproduzindo tom de teste (440 Hz)', 'info');
  });

  $('#btn-reconnect')?.addEventListener('click', tryConnect);
}

async function loadSettingsForm() {
  const { toggles } = appData;
  if (toggles) {
    $('#toggle-auto-record').checked = !!toggles.autoRecord;
    $('#toggle-call-waiting').checked = toggles.callWaiting !== false;
  }
  applyAutoAnswerLockUi();

  try {
    const autoLaunch = await window.voxcall?.app?.getAutoLaunch?.();
    const enabled = autoLaunch !== false;
    appData.autoLaunch = enabled;
    if ($('#toggle-auto-launch')) $('#toggle-auto-launch').checked = enabled;
  } catch {
    if ($('#toggle-auto-launch')) $('#toggle-auto-launch').checked = true;
  }
}

// ─── Contacts ────────────────────────────────────────────────────────────────
function bindContacts() {
  $('#contacts-search')?.addEventListener('input', (e) => {
    contactsManager.searchQuery = e.target.value;
    renderContacts();
  });

  $('#btn-add-contact')?.addEventListener('click', () => openContactModal());
  $('#btn-save-contact')?.addEventListener('click', saveContact);
  $('#btn-cancel-contact')?.addEventListener('click', closeContactModal);
  $('#contact-modal-close')?.addEventListener('click', closeContactModal);
}

function renderContacts() {
  const list = $('#contacts-list');
  if (!list) return;
  const contacts = contactsManager.getFiltered();
  list.innerHTML = contacts.length ? contacts.map((c) => `
    <div class="contact-item" data-id="${c.id}">
      <div class="contact-info">
        <span class="contact-fav" data-action="fav">${c.favorite ? '★' : '☆'}</span>
        <div>
          <div class="contact-name">${esc(c.name)}</div>
          <div class="contact-phone">${formatPhoneDisplay(c.phone)}</div>
          ${c.company ? `<div class="contact-meta">${esc(c.company)}</div>` : ''}
        </div>
      </div>
      <div class="contact-actions">
        <button class="btn-icon" data-action="call" title="Ligar">📞</button>
        <button class="btn-icon" data-action="edit" title="Editar">✏️</button>
        <button class="btn-icon" data-action="delete" title="Excluir">🗑️</button>
      </div>
    </div>
  `).join('') : '<p class="empty-msg">Nenhum contato encontrado.</p>';

  list.querySelectorAll('.contact-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('[data-action="call"]')?.addEventListener('click', () => makeCall(
      contactsManager.contacts.find((c) => c.id === id)?.phone
    ));
    item.querySelector('[data-action="fav"]')?.addEventListener('click', async () => {
      await contactsManager.toggleFavorite(id);
      renderContacts();
    });
    item.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
      const c = contactsManager.contacts.find((x) => x.id === id);
      openContactModal(c);
    });
    item.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      if (confirm('Excluir este contato?')) {
        await contactsManager.remove(id);
        renderContacts();
      }
    });
  });
}

let editingContactId = null;

function openContactModal(contact = null) {
  editingContactId = contact?.id || null;
  $('#contact-modal').classList.add('visible');
  $('#contact-modal-title').textContent = contact ? 'Editar Contato' : 'Novo Contato';
  $('#contact-name').value = contact?.name || '';
  $('#contact-phone').value = contact?.phone || '';
  $('#contact-email').value = contact?.email || '';
  $('#contact-company').value = contact?.company || '';
}

function closeContactModal() {
  $('#contact-modal').classList.remove('visible');
  editingContactId = null;
}

async function saveContact() {
  const data = {
    name: $('#contact-name').value,
    phone: $('#contact-phone').value,
    email: $('#contact-email').value,
    company: $('#contact-company').value,
  };
  try {
    if (editingContactId) await contactsManager.update(editingContactId, data);
    else await contactsManager.add(data);
    closeContactModal();
    renderContacts();
    showToast('Contato salvo', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ─── Call History ────────────────────────────────────────────────────────────
function historyStatusLabel(status) {
  return HISTORY_STATUS_LABELS[status] || status || '—';
}

function getUnreadMissedCalls() {
  return (appData.callHistory || []).filter((h) => h.status === 'missed' && h.viewed === false);
}

async function finalizeHistoryOnCallEnd({
  answered = false,
  rejectedByUser = false,
  duration = 0,
} = {}) {
  const history = await storage.getCallHistory();
  if (!history.length) return;

  const last = history[0];
  if (answered || last.status === 'answered') {
    last.status = 'ended';
    last.duration = duration;
  } else if (last.direction === 'incoming') {
    if (rejectedByUser) {
      last.status = 'rejected';
      last.viewed = true;
    } else {
      last.status = 'missed';
      last.viewed = false;
    }
    last.duration = 0;
  } else if (last.direction === 'outgoing' && last.status === 'calling') {
    last.status = 'failed';
    last.duration = 0;
  } else {
    last.status = 'ended';
    last.duration = duration;
  }

  await storage.setCallHistory(history);
  appData.callHistory = history;
}

function updateMissedAlert() {
  const unread = getUnreadMissedCalls();
  const count = unread.length;
  const banner = $('#missed-banner');
  const badge = $('#missed-badge');
  const text = $('#missed-banner-text');

  if (badge) {
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = String(count > 99 ? '99+' : count);
    } else {
      badge.hidden = true;
      badge.textContent = '0';
    }
  }

  if (!banner) return;

  if (count > 0) {
    const latest = unread[0];
    const who = latest?.name || formatPhoneDisplay(latest?.number || '') || 'Número desconhecido';
    banner.hidden = false;
    banner.classList.add('visible');
    document.body.classList.add('has-missed-banner');
    if (text) {
      text.textContent = count === 1
        ? who
        : `${count} chamadas · última: ${who}`;
    }
    const label = banner.querySelector('.missed-label');
    if (label) label.textContent = count === 1 ? 'Chamada perdida' : 'Chamadas perdidas';
  } else {
    banner.hidden = true;
    banner.classList.remove('visible');
    document.body.classList.remove('has-missed-banner');
  }
}

async function markMissedAsViewed() {
  const history = await storage.getCallHistory();
  let changed = false;
  for (const entry of history) {
    if (entry.status === 'missed' && entry.viewed === false) {
      entry.viewed = true;
      changed = true;
    }
  }
  if (changed) {
    await storage.setCallHistory(history);
    appData.callHistory = history;
  }
  updateMissedAlert();
  renderHistory();
}

function bindMissedBanner() {
  $('#missed-banner')?.addEventListener('click', () => {
    switchView('history');
  });
}

async function addHistoryEntry(entry) {
  const record = {
    id: generateId(),
    ...entry,
    timestamp: new Date().toISOString(),
    duration: 0,
  };
  await storage.addCallRecord(record);
  appData.callHistory = await storage.getCallHistory();
}

async function updateHistoryLast(status, extra = {}) {
  const history = await storage.getCallHistory();
  if (!history.length) return;
  history[0].status = status;
  Object.assign(history[0], extra);
  if (status === 'ended' || status === 'answered') {
    history[0].duration = callSeconds;
  }
  await storage.setCallHistory(history);
  appData.callHistory = history;
}

function renderHistory() {
  const list = $('#history-list');
  if (!list) return;
  const history = appData.callHistory || [];
  list.innerHTML = history.length ? history.map((h) => {
    const isMissed = h.status === 'missed';
    const unread = isMissed && h.viewed === false;
    const statusLabel = historyStatusLabel(h.status);
    const statusClass = isMissed ? 'history-status-missed' : '';
    return `
    <div class="history-item${isMissed ? ' history-missed' : ''}${unread ? ' history-missed-unread' : ''}" data-number="${esc(h.number)}">
      <span class="history-dir${isMissed ? ' missed' : ''}">${h.direction === 'incoming' ? '↓' : '↑'}</span>
      <div class="history-info">
        <div class="history-number">${esc(h.name || formatPhoneDisplay(h.number))}</div>
        <div class="history-meta">${formatDateTime(h.timestamp)} · <span class="${statusClass}">${esc(statusLabel)}</span></div>
      </div>
      <div class="history-actions">
        ${h.duration ? `<span class="history-dur">${formatDuration(h.duration)}</span>` : ''}
        <button class="btn-icon history-call" title="Ligar">📞</button>
      </div>
    </div>`;
  }).join('') : '<p class="empty-msg">Nenhum registro de chamada.</p>';

  list.querySelectorAll('.history-call').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const number = e.target.closest('.history-item')?.dataset.number;
      if (number) makeCall(number);
    });
  });
}

function bindHistory() {
  $('#btn-clear-history')?.addEventListener('click', async () => {
    if (confirm('Limpar todo o histórico?')) {
      await storage.setCallHistory([]);
      appData.callHistory = [];
      renderHistory();
      updateMissedAlert();
    }
  });
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────
function updateDiagField(field, value) {
  const el = document.getElementById(`diag-${field}`);
  if (el) el.textContent = value;
}

async function updateDiagnostics() {
  const perms = await sipClient.getPermissionStatus();
  updateDiagField('mic-perm', perms.microphone);
  renderDiagnostics(sipClient.getDiagnostics());
}

function renderDiagnostics(d) {
  if (!d) return;
  updateDiagField('reg', d.registration);
  updateDiagField('ws', d.websocket);
  updateDiagField('ice', d.ice);
  updateDiagField('ua', d.uaStatus);

  const tracksEl = $('#diag-tracks');
  if (tracksEl) {
    tracksEl.innerHTML = d.tracks?.length
      ? d.tracks.map((t) => `<div class="track-item">${t.direction} · ${t.kind} · ${esc(t.label)} · ${t.enabled ? 'ativo' : 'inativo'}</div>`).join('')
      : '<span class="text-muted">Nenhuma faixa ativa</span>';
  }
}

// ─── Utils ───────────────────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  $('#toast-container')?.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

// ─── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

// Export for external use
window.voxcallApp = { makeCall, switchView };
