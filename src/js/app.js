import { sipClient, CallState } from './sip-client.js';
import { storage } from './storage.js';
import { contactsManager } from './contacts.js';
import { setupBrowserDetector } from './browser-detector.js';
import {
  formatPhoneDisplay, formatDuration, formatDateTime,
  normalizePhone, isValidPhone, generateId,
} from './utils.js';

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

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  appData = await storage.getAll();
  applyTheme(appData.theme || 'dark');
  await contactsManager.load();
  bindNavigation();
  bindDialpad();
  bindCallControls();
  bindSettings();
  bindContacts();
  bindHistory();
  bindTransfer();
  bindShortcuts();
  bindBrowser();
  bindSipEvents();
  renderStatus();
  renderContacts();
  renderHistory();
  updateDiagnostics();

  if (appData.sip?.websocketUrl) {
    tryConnect();
  }
}

// ─── Theme ───────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️ Claro' : '🌙 Escuro';
}

async function toggleTheme() {
  const next = appData.theme === 'dark' ? 'light' : 'dark';
  appData.theme = next;
  await storage.setTheme(next);
  applyTheme(next);
}

// ─── SIP Connection ──────────────────────────────────────────────────────────
async function tryConnect() {
  appData = await storage.getAll();
  try {
    await sipClient.connect(appData.sip, appData.toggles);
    setStatus('connecting', 'Conectando...');
  } catch (e) {
    setStatus('error', e.message);
  }
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
    showIncomingBanner(info);
    addHistoryEntry({ direction: 'incoming', number: info.caller, name: info.display, status: 'missed' });
  });

  sipClient.on('outgoing', (info) => {
    showCallPanel(info.target);
    addHistoryEntry({ direction: 'outgoing', number: info.target, status: 'calling' });
  });

  sipClient.on('callState', ({ state }) => {
    if (state === CallState.CONNECTED) {
      startCallTimer();
      $('#call-status').textContent = 'Em chamada';
      updateHistoryLast('answered');
    } else if (state === CallState.RINGING) {
      $('#call-status').textContent = 'Chamando...';
    } else if (state === CallState.HELD) {
      isHeld = true;
      $('#call-status').textContent = 'Em espera';
      $('#btn-hold').textContent = '▶ Retomar';
    }
  });

  sipClient.on('callEnded', () => {
    hideCallPanel();
    hideIncomingBanner();
    stopCallTimer();
    isMuted = false;
    isHeld = false;
    incomingInfo = null;
    updateHistoryLast('ended');
    renderHistory();
  });

  sipClient.on('hold', ({ held }) => {
    isHeld = held;
    $('#btn-hold').textContent = held ? '▶ Retomar' : '⏸ Espera';
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
function setStatus(type, text) {
  const el = $('#status-badge');
  if (!el) return;
  el.className = `status-badge status-${type}`;
  el.textContent = text;
}

function renderStatus() {
  const d = sipClient.getDiagnostics();
  setStatus(d.registration === 'registered' ? 'registered' : 'offline',
    d.registration === 'registered' ? 'Registrado' : 'Desconectado');
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
}

// ─── Dialpad ─────────────────────────────────────────────────────────────────
function bindDialpad() {
  $$('.dial-key').forEach((key) => {
    key.addEventListener('click', () => appendDial(key.dataset.digit));
  });

  $('#dial-input')?.addEventListener('input', (e) => {
    dialBuffer = e.target.value;
  });

  $('#btn-backspace')?.addEventListener('click', () => {
    dialBuffer = dialBuffer.slice(0, -1);
    $('#dial-input').value = dialBuffer;
  });

  $('#btn-clear')?.addEventListener('click', () => {
    dialBuffer = '';
    $('#dial-input').value = '';
  });

  $('#btn-call')?.addEventListener('click', () => makeCall(dialBuffer));

  document.addEventListener('keydown', (e) => {
    if (currentView !== 'dialpad') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (/^[0-9*#+]$/.test(e.key)) {
      appendDial(e.key);
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      dialBuffer = dialBuffer.slice(0, -1);
      $('#dial-input').value = dialBuffer;
    } else if (e.key === 'Enter') {
      makeCall(dialBuffer);
    }
  });
}

function appendDial(digit) {
  dialBuffer += digit;
  $('#dial-input').value = dialBuffer;
}

async function makeCall(number, auto = false) {
  const n = normalizePhone(number);
  if (!isValidPhone(n) && !isValidPhone(number)) {
    showToast('Número inválido', 'error');
    return;
  }
  const target = n || number;
  try {
    sipClient.call(target);
    showCallPanel(target);
    dialBuffer = '';
    $('#dial-input').value = '';
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ─── Call controls ───────────────────────────────────────────────────────────
function bindCallControls() {
  $('#btn-answer')?.addEventListener('click', () => sipClient.answer());
  $('#btn-reject')?.addEventListener('click', () => sipClient.reject());
  $('#btn-hangup')?.addEventListener('click', () => sipClient.hangup());
  $('#btn-mute')?.addEventListener('click', () => {
    isMuted = !isMuted;
    sipClient.mute(isMuted);
    $('#btn-mute').classList.toggle('active', isMuted);
    $('#btn-mute').textContent = isMuted ? '🔇 Silenciado' : '🎤 Mudo';
  });
  $('#btn-hold')?.addEventListener('click', () => {
    if (isHeld) sipClient.unhold();
    else sipClient.hold();
  });

  $$('.dtmf-key').forEach((key) => {
    key.addEventListener('click', () => {
      sipClient.sendDTMF(key.dataset.digit);
      flashDtmf(key.dataset.digit);
    });
  });
}

function showCallPanel(number) {
  $('#call-panel').classList.add('visible');
  $('#call-number').textContent = formatPhoneDisplay(number);
  $('#call-status').textContent = 'Chamando...';
  setMeter('meter-local', 0);
  setMeter('meter-remote', 0);
}

function hideCallPanel() {
  $('#call-panel').classList.remove('visible');
}

function showIncomingBanner(info) {
  $('#incoming-banner').classList.add('visible');
  $('#incoming-caller').textContent = info.display || info.caller;
  $('#incoming-number').textContent = formatPhoneDisplay(info.caller);
}

function hideIncomingBanner() {
  $('#incoming-banner').classList.remove('visible');
}

function startCallTimer() {
  callSeconds = 0;
  $('#call-timer').textContent = '00:00';
  callTimer = setInterval(() => {
    callSeconds++;
    $('#call-timer').textContent = formatDuration(callSeconds);
  }, 1000);
}

function stopCallTimer() {
  if (callTimer) clearInterval(callTimer);
  callTimer = null;
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
function bindSettings() {
  loadSettingsForm();

  $('#btn-save-sip')?.addEventListener('click', async () => {
    const sip = {
      domain: $('#sip-domain').value.trim(),
      websocketUrl: $('#sip-ws').value.trim(),
      sipUri: $('#sip-uri').value.trim(),
      extension: $('#sip-extension').value.trim(),
      displayName: $('#sip-display').value.trim(),
      password: $('#sip-password').value,
    };
    await storage.setSip(sip);
    appData.sip = sip;
    showToast('Configurações SIP salvas', 'success');
    tryConnect();
  });

  $$('.toggle-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const toggles = {
        autoAnswer: $('#toggle-auto-answer').checked,
        autoRecord: $('#toggle-auto-record').checked,
        callWaiting: $('#toggle-call-waiting').checked,
        clickToCall: $('#toggle-click-to-call').checked,
        autoDialClickToCall: $('#toggle-auto-dial').checked,
      };
      await storage.setToggles(toggles);
      appData.toggles = toggles;
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
  $('#btn-disconnect')?.addEventListener('click', () => {
    sipClient.disconnect();
    setStatus('offline', 'Desconectado');
  });
}

function loadSettingsForm() {
  const { sip, toggles } = appData;
  if (sip) {
    $('#sip-domain').value = sip.domain || '';
    $('#sip-ws').value = sip.websocketUrl || '';
    $('#sip-uri').value = sip.sipUri || '';
    $('#sip-extension').value = sip.extension || '';
    $('#sip-display').value = sip.displayName || '';
    $('#sip-password').value = sip.password || '';
  }
  if (toggles) {
    $('#toggle-auto-answer').checked = !!toggles.autoAnswer;
    $('#toggle-auto-record').checked = !!toggles.autoRecord;
    $('#toggle-call-waiting').checked = toggles.callWaiting !== false;
    $('#toggle-click-to-call').checked = toggles.clickToCall !== false;
    $('#toggle-auto-dial').checked = !!toggles.autoDialClickToCall;
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

async function updateHistoryLast(status) {
  const history = await storage.getCallHistory();
  if (!history.length) return;
  history[0].status = status;
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
  list.innerHTML = history.length ? history.map((h) => `
    <div class="history-item" data-number="${esc(h.number)}">
      <span class="history-dir">${h.direction === 'incoming' ? '↓' : '↑'}</span>
      <div class="history-info">
        <div class="history-number">${esc(h.name || formatPhoneDisplay(h.number))}</div>
        <div class="history-meta">${formatDateTime(h.timestamp)} · ${h.status}</div>
      </div>
      <div class="history-actions">
        ${h.duration ? `<span class="history-dur">${formatDuration(h.duration)}</span>` : ''}
        <button class="btn-icon history-call" title="Ligar">📞</button>
      </div>
    </div>
  `).join('') : '<p class="empty-msg">Nenhum registro de chamada.</p>';

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
    }
  });
}

// ─── Browser / tel: detection ────────────────────────────────────────────────
function bindBrowser() {
  const webview = $('#browser-webview');
  const urlInput = $('#browser-url');
  const goBtn = $('#browser-go');

  goBtn?.addEventListener('click', () => {
    let url = urlInput.value.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    webview.src = url;
  });

  urlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn?.click();
  });

  setupBrowserDetector(webview, (number) => {
    const toggles = appData.toggles || {};
    if (toggles.autoDialClickToCall) {
      makeCall(number);
    } else {
      dialBuffer = normalizePhone(number);
      $('#dial-input').value = dialBuffer;
      switchView('dialpad');
      showToast(`Número detectado: ${number}`, 'info');
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

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
function bindShortcuts() {
  if (!window.voxcall?.onShortcut) return;

  window.voxcall.onShortcut('shortcut:answer', () => sipClient.answer());
  window.voxcall.onShortcut('shortcut:hangup', () => sipClient.hangup());
  window.voxcall.onShortcut('shortcut:mute', () => {
    isMuted = !isMuted;
    sipClient.mute(isMuted);
  });
  window.voxcall.onShortcut('shortcut:hold', () => {
    if (isHeld) sipClient.unhold();
    else sipClient.hold();
  });
  window.voxcall.onShortcut('shortcut:dialpad-focus', () => {
    switchView('dialpad');
    $('#dial-input')?.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'F1') { e.preventDefault(); sipClient.answer(); }
    if (e.key === 'F2') { e.preventDefault(); sipClient.hangup(); }
    if (e.key === 'F3') { e.preventDefault(); { isMuted = !isMuted; sipClient.mute(isMuted); } }
    if (e.key === 'F4') { e.preventDefault(); isHeld ? sipClient.unhold() : sipClient.hold(); }
  });
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
