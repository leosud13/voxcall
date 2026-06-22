import { app, BrowserWindow, ipcMain, globalShortcut, shell, session } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Store from 'electron-store';

const __dirname = dirname(fileURLToPath(import.meta.url));
const store = new Store({ name: 'voxcall-data' });

let mainWindow = null;

const DEFAULTS = {
  sip: {
    domain: '',
    websocketUrl: '',
    sipUri: '',
    extension: '',
    displayName: '',
    password: '',
  },
  toggles: {
    autoAnswer: false,
    autoRecord: false,
    callWaiting: true,
    clickToCall: true,
    autoDialClickToCall: false,
  },
  theme: 'dark',
  contacts: [],
  callHistory: [],
  favorites: [],
};

function getDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'VoxCall',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(join(__dirname, '..', 'src', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerShortcuts() {
  const shortcuts = [
  { key: 'F1', channel: 'shortcut:answer' },
  { key: 'F2', channel: 'shortcut:hangup' },
  { key: 'F3', channel: 'shortcut:mute' },
  { key: 'F4', channel: 'shortcut:hold' },
  { key: 'F5', channel: 'shortcut:dialpad-focus' },
  ];

  shortcuts.forEach(({ key, channel }) => {
    globalShortcut.register(key, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel);
      }
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'audio', 'audioCapture'].includes(permission);
    callback(allowed);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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

ipcMain.handle('app:getVersion', () => app.getVersion());
