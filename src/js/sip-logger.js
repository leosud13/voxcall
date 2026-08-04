/** Buffer de debug SIP para console + painel de Diagnóstico. */

const PREFIX = '[vcall SIP]';
const MAX_ENTRIES = 200;

const listeners = new Set();
const entries = [];
let lastIncomingIdentity = null;
let enabled = true;

function emit() {
  const snapshot = {
    enabled,
    entries: [...entries],
    lastIncomingIdentity,
  };
  listeners.forEach((fn) => {
    try { fn(snapshot); } catch { /* ignore */ }
  });
}

function push(level, message, data) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    level,
    message,
    data: data === undefined ? null : data,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  const time = entry.ts.split('T')[1]?.replace('Z', '') || '';
  if (level === 'error') {
    if (data !== undefined) console.error(`${PREFIX} ${time} ${message}`, data);
    else console.error(`${PREFIX} ${time} ${message}`);
  } else if (data !== undefined) {
    console.log(`${PREFIX} ${time} ${message}`, data);
  } else {
    console.log(`${PREFIX} ${time} ${message}`);
  }

  // Terminal do Electron (npm start) — console do renderer não aparece lá sozinho
  try {
    const terminalData = data == null
      ? null
      : (typeof data === 'object'
        ? {
            ...data,
            // Evita flood: raw completo só no painel; no terminal manda preview
            rawSip: undefined,
            rawSipPreview: data.rawSipPreview || (data.rawSip ? String(data.rawSip).slice(0, 1200) : undefined),
          }
        : data);
    window.voxcall?.log?.sip?.({
      level,
      message: `${time} ${message}`,
      data: terminalData,
    });
  } catch {
    /* ignore */
  }

  emit();
  return entry;
}

export const sipDebug = {
  enable() {
    enabled = true;
    push('info', 'Debug SIP habilitado');
  },

  disable() {
    enabled = false;
    push('info', 'Debug SIP desabilitado');
  },

  isEnabled() {
    return enabled;
  },

  log(message, data) {
    if (!enabled) return;
    push('info', message, data);
  },

  error(message, data) {
    push('error', message, data);
  },

  setLastIncomingIdentity(payload) {
    lastIncomingIdentity = {
      ...payload,
      capturedAt: new Date().toISOString(),
    };
    push('info', 'Identidade da chamada recebida', lastIncomingIdentity);
  },

  getLastIncomingIdentity() {
    return lastIncomingIdentity;
  },

  getEntries() {
    return [...entries];
  },

  clear() {
    entries.length = 0;
    lastIncomingIdentity = null;
    emit();
  },

  subscribe(fn) {
    listeners.add(fn);
    fn({
      enabled,
      entries: [...entries],
      lastIncomingIdentity,
    });
    return () => listeners.delete(fn);
  },

  formatForCopy() {
    const lines = entries.map((e) => {
      const data = e.data == null ? '' : ` ${JSON.stringify(e.data)}`;
      return `${e.ts} [${e.level}] ${e.message}${data}`;
    });
    if (lastIncomingIdentity) {
      lines.push('');
      lines.push('=== ÚLTIMA CHAMADA RECEBIDA ===');
      lines.push(JSON.stringify(lastIncomingIdentity, null, 2));
    }
    return lines.join('\n');
  },
};
