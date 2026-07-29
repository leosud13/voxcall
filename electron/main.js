import { app, BrowserWindow, ipcMain, shell, session, Menu, Tray, nativeImage, net, screen } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { connect as netConnect } from 'net';
import Store from 'electron-store';
import { setupAutoUpdater, checkForUpdates, installUpdate } from './updater.js';

// Evita STUN em adaptadores virtuais (ex.: VirtualBox 192.168.56.x)
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'default_public_interface_only');

const __dirname = dirname(fileURLToPath(import.meta.url));
const store = new Store({ name: 'voxcall-data' });

let mainWindow = null;
let tray = null;
let callAlertWindow = null;
let isQuitting = false;

const DEFAULTS = {
  sip: {
    domain: '',
    websocketUrl: '',
    sipUri: '',
    extension: '',
    displayName: '',
    password: '',
    stunUrl: '',
  },
  toggles: {
    autoAnswer: false,
    autoAnswerLocked: false,
    autoRecord: false,
    callWaiting: true,
  },
  theme: 'dark',
  customLogos: {
    dark: '',
    light: '',
  },
  brandLogos: {
    titulo: '',
    webphone: '',
  },
  autoLaunch: true,
  contacts: [],
  callHistory: [],
  callerNames: {},
  favorites: [],
  auth: {
    loggedIn: false,
    username: '',
    passwordMd5: '',
    remember: false,
    manual: false,
    displayName: '',
    label: '',
  },
};

function getDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function getAppIconPath() {
  return join(__dirname, '..', 'assets', 'icon.ico');
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setAlwaysOnTop(false);
  }
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function closeCallAlert() {
  if (callAlertWindow && !callAlertWindow.isDestroyed()) {
    callAlertWindow.close();
  }
  callAlertWindow = null;
}

function showCallAlert({ caller = 'Desconhecido', number = '' } = {}) {
  closeCallAlert();

  const displayName = String(caller || number || 'Desconhecido');
  const displayNumber = String(number || caller || '');

  // Pop-up sempre no topo com Atender / Recusar (sem toast do Windows, que sobrepunha este alerta)
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh, workArea } = display;
  const winW = 340;
  const winH = 170;
  const x = Math.round((workArea?.x || 0) + (workArea?.width || sw) - winW - 16);
  const y = Math.round((workArea?.y || 0) + (workArea?.height || sh) - winH - 16);

  callAlertWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    focusable: true,
    title: 'Chamada recebida',
    icon: getAppIconPath(),
    webPreferences: {
      preload: join(__dirname, 'call-alert-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  callAlertWindow.setAlwaysOnTop(true, 'screen-saver');
  callAlertWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  callAlertWindow.loadFile(join(__dirname, 'call-alert.html'), {
    query: {
      caller: displayName,
      number: displayNumber,
    },
  });
  callAlertWindow.once('ready-to-show', () => {
    if (callAlertWindow && !callAlertWindow.isDestroyed()) {
      callAlertWindow.show();
      callAlertWindow.moveTop();
    }
  });
  callAlertWindow.on('closed', () => {
    callAlertWindow = null;
  });
}

function sendCallAction(action) {
  showMainWindow();
  closeCallAlert();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('call:action', { action });
  }
}

function applyAutoLaunch(enabled) {
  const openAtLogin = !!enabled;
  if (!app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin,
      path: process.execPath,
      args: openAtLogin ? [join(__dirname, '..'), '--hidden'] : [],
    });
    return openAtLogin;
  }

  app.setLoginItemSettings({
    openAtLogin,
    args: openAtLogin ? ['--hidden'] : [],
  });
  return openAtLogin;
}

function ensureAutoLaunchDefault() {
  if (!store.has('autoLaunch')) {
    store.set('autoLaunch', true);
  }
  const enabled = store.get('autoLaunch', true) !== false;
  applyAutoLaunch(enabled);
  return enabled;
}

function shouldStartHidden() {
  return process.argv.includes('--hidden') || process.argv.includes('--autostart');
}

function createTray() {
  if (tray) return;

  const icon = nativeImage.createFromPath(getAppIconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('VoxCall');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir VoxCall',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => showMainWindow());
  tray.on('click', () => showMainWindow());
}

function createWindow() {
  const startHidden = shouldStartHidden();

  mainWindow = new BrowserWindow({
    width: 400,
    height: 824,
    minWidth: 360,
    minHeight: 746,
    title: 'VoxCall',
    icon: getAppIconPath(),
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    show: !startHidden,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(join(__dirname, '..', 'src', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Encaminha logs do renderer (SIP / JsSIP) para o terminal do npm start
  mainWindow.webContents.on('console-message', (...args) => {
    const details = args.length === 1 && args[0] && typeof args[0] === 'object'
      ? args[0]
      : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    const message = String(details.message ?? '');
    const level = Number(details.level ?? 1);
    const isSip = /\[VoxCall SIP\]|\[VoxCall\]|JsSIP/i.test(message);
    if (!isSip && level < 2) return;

    const prefix = level >= 3 ? '[renderer:error]' : level === 2 ? '[renderer:warn]' : '[renderer]';
    if (level >= 3) console.error(prefix, message);
    else if (level === 2) console.warn(prefix, message);
    else console.log(prefix, message);
  });

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Fechar (X) → minimize para a bandeja e continua em background
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideToTray();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (startHidden) {
    mainWindow.once('ready-to-show', () => {
      hideToTray();
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.voxcall.softphone');
  }
  Menu.setApplicationMenu(null);
  ensureAutoLaunchDefault();
  createTray();
  createWindow();
  setupAutoUpdater(() => mainWindow);

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['media', 'microphone', 'audio', 'audioCapture', 'speaker-selection'].includes(permission);
      callback(allowed);
    });

    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return ['media', 'microphone', 'audio', 'audioCapture', 'speaker-selection'].includes(permission);
    });

    session.defaultSession.setDevicePermissionHandler(async (_wc, permission, _requestingOrigin, details) => {
      if (permission === 'media') {
        const mediaType = details?.mediaType;
        return mediaType === 'audio' || mediaType === 'video';
      }
      return false;
    });

    app.on('activate', () => {
      showMainWindow();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  closeCallAlert();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  // No Windows/Linux o app permanece na bandeja; só encerra via menu "Sair".
});

ipcMain.on('call-alert:answer', () => sendCallAction('answer'));
ipcMain.on('call-alert:reject', () => sendCallAction('reject'));

ipcMain.handle('call:notify-incoming', (_e, payload) => {
  showCallAlert(payload || {});
  return true;
});

ipcMain.handle('call:clear-incoming', () => {
  closeCallAlert();
  return true;
});

// Storage IPC
ipcMain.handle('store:get', (_e, key) => {
  if (key) return store.get(key, getDefaults()[key]);
  return { ...getDefaults(), ...store.store };
});

ipcMain.handle('store:set', (_e, key, value) => {
  store.set(key, value);
  return true;
});

ipcMain.handle('store:getAll', () => ({ ...getDefaults(), ...store.store }));

ipcMain.handle('store:reset', () => {
  store.clear();
  return getDefaults();
});

ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

ipcMain.handle('net:latency', async (_e, host, port) => {
  const hostname = String(host || '').trim();
  const portNum = Number(port);
  if (!hostname || !Number.isFinite(portNum) || portNum <= 0) return null;

  return new Promise((resolve) => {
    const start = Date.now();
    const socket = netConnect({ host: hostname, port: portNum });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };

    socket.setTimeout(4000);
    socket.once('connect', () => finish(Math.max(1, Date.now() - start)));
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
  });
});

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('app:openDevTools', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.openDevTools({ mode: 'detach' });
  return true;
});

ipcMain.on('log:sip', (_e, payload) => {
  const level = payload?.level === 'error' ? 'error' : 'log';
  const msg = `[VoxCall SIP] ${payload?.message || ''}`;
  const data = payload?.data;
  if (data !== undefined && data !== null) {
    console[level](msg, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } else {
    console[level](msg);
  }
});

ipcMain.handle('app:getAutoLaunch', () => store.get('autoLaunch', true) !== false);

ipcMain.handle('app:setAutoLaunch', (_e, enabled) => {
  const value = !!enabled;
  store.set('autoLaunch', value);
  applyAutoLaunch(value);
  return value;
});

ipcMain.handle('updater:check', () => checkForUpdates());
ipcMain.handle('updater:install', () => installUpdate());

async function downloadLogoToCache(url, key) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('data:') || value.startsWith('file:')) return value;

  const response = await net.fetch(value, {
    bypassCustomProtocolHandlers: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VoxCall/1.0',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 32 || buffer.length > 2 * 1024 * 1024) {
    throw new Error(`Tamanho inválido do logo: ${buffer.length}`);
  }

  // Valida se é imagem real
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    throw new Error('Conteúdo baixado não é uma imagem válida');
  }

  const mime = String(response.headers.get('content-type') || '').toLowerCase();
  let ext = 'png';
  if (mime.includes('jpeg') || mime.includes('jpg') || buffer[0] === 0xff) ext = 'jpg';
  else if (mime.includes('webp')) ext = 'webp';
  else if (mime.includes('gif')) ext = 'gif';
  else if (mime.includes('svg')) ext = 'svg';

  const logosDir = join(app.getPath('userData'), 'logos');
  mkdirSync(logosDir, { recursive: true });
  const filePath = join(logosDir, `${key}.${ext}`);
  writeFileSync(filePath, buffer);

  // data URL é mais compatível com CSP do renderer
  const png = image.toPNG();
  return `data:image/png;base64,${png.toString('base64')}`;
}

ipcMain.handle('logo:fetch', async (_e, urls, key = 'logo') => {
  const list = Array.isArray(urls) ? urls : [urls];
  const safeKey = String(key || 'logo').replace(/[^\w-]+/g, '_');

  for (const item of list) {
    const value = String(item || '').trim();
    if (!value) continue;
    try {
      const cached = await downloadLogoToCache(value, safeKey);
      if (cached) {
        console.log('[VoxCall] logo cached', safeKey, value);
        return cached;
      }
    } catch (err) {
      console.error('[VoxCall] logo:fetch failed', value, err?.message || err);
    }
  }

  return '';
});
