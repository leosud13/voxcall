import { app } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let getWindow = () => null;

function sendStatus(payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', payload);
  }
}

function formatUpdaterError(err) {
  const message = err?.message || 'Erro ao verificar atualizações';
  if (/404|not found|no published versions/i.test(message)) {
    return 'Nenhuma versão publicada no GitHub. Aguarde um novo release.';
  }
  if (/net::|network|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return 'Sem conexão com o servidor de atualizações.';
  }
  return message;
}

export function setupAutoUpdater(getMainWindow) {
  getWindow = getMainWindow;

  if (!app.isPackaged) {
    sendStatus({ state: 'dev' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    sendStatus({ state: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendStatus({ state: 'not-available', version: info?.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent || 0),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({ state: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    sendStatus({ state: 'error', message: formatUpdaterError(err) });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      sendStatus({ state: 'error', message: formatUpdaterError(err) });
    });
  };

  setTimeout(check, 8000);
  setInterval(check, CHECK_INTERVAL_MS);
}

export async function checkForUpdates() {
  if (!app.isPackaged) {
    return { skipped: true, reason: 'dev' };
  }
  try {
    return await autoUpdater.checkForUpdates();
  } catch (err) {
    sendStatus({ state: 'error', message: formatUpdaterError(err) });
    throw err;
  }
}

export function installUpdate() {
  if (!app.isPackaged) return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
}
