import JsSIP from 'jssip';
import { buildSipUri, buildCallUri, extractSipDomain } from './utils.js';
import { dialLog, dialError } from './debug.js';
import { RingbackTone } from './ringback.js';
import { IncomingRingtone } from './ringtone.js';
import { sipDebug } from './sip-logger.js';

try {
  JsSIP.debug.enable('JsSIP:*');
  sipDebug.enable();
  sipDebug.log('JsSIP.debug.enable(JsSIP:*) ativo desde o carregamento do módulo');
} catch (err) {
  sipDebug.error('Falha ao ativar JsSIP.debug', err);
}

export const CallState = {
  IDLE: 'idle',
  REGISTERING: 'registering',
  REGISTERED: 'registered',
  UNREGISTERED: 'unregistered',
  CALLING: 'calling',
  RINGING: 'ringing',
  INCOMING: 'incoming',
  CONNECTED: 'connected',
  HELD: 'held',
  ENDED: 'ended',
};

export class SipClient {
  constructor() {
    this.ua = null;
    this.session = null;
    this.consultSession = null;
    this.remoteAudio = null;
    this.localStream = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.listeners = new Map();
    this.registrationState = 'unregistered';
    this.wsState = 'closed';
    this.iceState = 'new';
    this.diagnostics = {};
    this.toggles = {};
    this.sipConfig = {};
    this._meterInterval = null;
    this._ringback = new RingbackTone();
    this._ringtone = new IncomingRingtone();
    this._hasRemoteAudio = false;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, data) {
    this.listeners.get(event)?.forEach((fn) => fn(data));
  }

  async connect(config, toggles) {
    this.disconnect();
    this.sipConfig = this._normalizeConfig(config);
    this.toggles = toggles || {};

    const { websocketUrl, sipUri, password } = this.sipConfig;
    if (!websocketUrl || !sipUri) {
      throw new Error('URL WebSocket e URI SIP (ou ramal + domínio) são obrigatórios.');
    }
    if (!password) {
      throw new Error('Senha SIP é obrigatória.');
    }

    const socket = new JsSIP.WebSocketInterface(websocketUrl);
    socket.via_transport = websocketUrl.startsWith('wss') ? 'WSS' : 'WS';

    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: sipUri,
      password,
      display_name: this.sipConfig.displayName || this.sipConfig.extension || '',
      register: true,
      session_timers: false,
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 30,
    });

    this._bindUaEvents();
    this.ua.start();

    try {
      JsSIP.debug.enable('JsSIP:*');
      sipDebug.enable();
      sipDebug.log('JsSIP debug reativado no connect');
      dialLog('JsSIP debug ativado');
    } catch {
      /* optional */
    }

    dialLog('Conectando UA SIP', {
      websocketUrl,
      sipUri,
      domain: this.sipConfig.domain,
      extension: this.sipConfig.extension,
    });
    sipDebug.log('Conectando UA SIP', {
      websocketUrl,
      sipUri,
      domain: this.sipConfig.domain,
      extension: this.sipConfig.extension,
      displayName: this.sipConfig.displayName,
    });

    this.emit('state', { registration: 'registering', ws: 'connecting' });
  }

  disconnect() {
    this._stopRingback();
    this._stopRingtone();
    this._clearRemoteAudio();
    this._stopMeters();
    this._stopRecording();
    if (this.session) {
      try { this.session.terminate(); } catch { /* ignore */ }
      this.session = null;
    }
    if (this.consultSession) {
      try { this.consultSession.terminate(); } catch { /* ignore */ }
      this.consultSession = null;
    }
    if (this.ua) {
      try { this.ua.stop(); } catch { /* ignore */ }
      this.ua = null;
    }
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.registrationState = 'unregistered';
    this.wsState = 'closed';
    this.emit('state', { registration: this.registrationState, ws: this.wsState });
  }

  _bindUaEvents() {
    const ua = this.ua;

    ua.on('connected', () => {
      this.wsState = 'connected';
      this.emit('state', { ws: this.wsState });
      this.emit('diagnostics', this.getDiagnostics());
    });

    ua.on('disconnected', () => {
      this.wsState = 'closed';
      this.registrationState = 'unregistered';
      this.emit('state', { ws: this.wsState, registration: this.registrationState });
      this.emit('diagnostics', this.getDiagnostics());
    });

    ua.on('registered', () => {
      this.registrationState = 'registered';
      this.emit('state', { registration: this.registrationState });
      this.emit('diagnostics', this.getDiagnostics());
    });

    ua.on('unregistered', () => {
      this.registrationState = 'unregistered';
      this.emit('state', { registration: this.registrationState });
      this.emit('diagnostics', this.getDiagnostics());
    });

    ua.on('registrationFailed', (e) => {
      this.registrationState = 'failed';
      this.emit('state', { registration: this.registrationState, cause: e.cause });
      this.emit('diagnostics', this.getDiagnostics());
    });

    ua.on('newRTCSession', (data) => {
      const session = data.session;
      const req = data.request;
      sipDebug.log('newRTCSession', {
        direction: session.direction,
        from: req?.getHeader?.('From') || req?.getHeader?.('from') || null,
        to: req?.getHeader?.('To') || req?.getHeader?.('to') || null,
        callId: req?.getHeader?.('Call-ID') || req?.getHeader?.('Call-Id') || null,
        hasRequestData: Boolean(req?.data),
        requestDataLength: String(req?.data || '').length,
      });
      if (session.direction === 'incoming') {
        if (this.session && this.toggles.callWaiting) {
          this._handleIncoming(session, data.request);
        } else if (!this.session) {
          this._handleIncoming(session, data.request);
        } else {
          session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
        }
      }
    });
  }

  _escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _isUsefulDisplayName(name, caller) {
    const n = String(name || '').trim().replace(/^"(.*)"$/, '$1').trim();
    const c = String(caller || '').trim();
    if (!n) return false;
    if (/^sip:/i.test(n) || /^tel:/i.test(n)) return false;
    if (c && n.toLowerCase() === c.toLowerCase()) return false;
    return true;
  }

  _extractDisplayName(nameAddr, rawHeader = '') {
    let name = String(nameAddr?.display_name ?? '').trim();
    name = name.replace(/^"(.*)"$/, '$1').trim();

    const header = String(rawHeader || '').trim();
    if (!name && header) {
      const quoted = header.match(/"([^"]+)"/);
      const unquoted = header.match(/^([^"<;][^<]*?)\s*</);
      const candidate = (quoted?.[1] || unquoted?.[1] || '').trim();
      if (candidate && !/^sip:/i.test(candidate) && !/^tel:/i.test(candidate)) {
        name = candidate.replace(/^"(.*)"$/, '$1').trim();
      }
    }

    if (!name && header && !header.includes('<') && !/^sip:/i.test(header) && !/^tel:/i.test(header)) {
      const plain = header.replace(/^"(.*)"$/, '$1').trim();
      if (plain) name = plain;
    }

    return name;
  }

  _extractNameForCaller(rawText, caller) {
    const text = String(rawText || '');
    const user = String(caller || '').trim();
    if (!text || !user) return '';

    const esc = this._escapeRegex(user);
    const patterns = [
      new RegExp(`"([^"]+)"\\s*<\\s*(?:sip:)?${esc}@`, 'i'),
      new RegExp(`"([^"]+)"\\s*<\\s*(?:sip:)?${esc}>`, 'i'),
      new RegExp(`([^\\"\\r\\n<:;]+?)\\s*<\\s*(?:sip:)?${esc}@`, 'i'),
    ];

    for (const re of patterns) {
      const match = text.match(re);
      const candidate = String(match?.[1] || '').trim().replace(/^"(.*)"$/, '$1').trim();
      if (this._isUsefulDisplayName(candidate, user)) return candidate;
    }
    return '';
  }

  _listRequestHeaders(request) {
    const headers = request?.headers || {};
    const out = {};
    for (const [key, arr] of Object.entries(headers)) {
      out[key] = (arr || []).map((h) => h?.raw).filter(Boolean);
    }
    return out;
  }

  _resolveRemoteParty(session, request = null) {
    const req = request || session._request;
    const identity = session.remote_identity;
    const parsedFrom = req?.parseHeader?.('From') || req?.parseHeader?.('from') || null;
    const rawSip = String(req?.data || '');
    const allHeaders = this._listRequestHeaders(req);
    const headerBlob = Object.entries(allHeaders)
      .flatMap(([key, values]) => values.map((value) => `${key}: ${value}`))
      .join('\n');

    const fromRaw = req?.getHeader?.('From')
      || req?.getHeader?.('from')
      || identity?.toString?.()
      || '';
    const paiRaw = req?.getHeader?.('P-Asserted-Identity')
      || req?.getHeader?.('P-Preferred-Identity')
      || '';
    const rpidRaw = req?.getHeader?.('Remote-Party-ID') || '';
    const contactRaw = req?.getHeader?.('Contact') || '';
    const callerNameRaw = req?.getHeader?.('Caller-ID-Name')
      || req?.getHeader?.('CNAM')
      || req?.getHeader?.('X-Caller-Name')
      || req?.getHeader?.('X-Display-Name')
      || '';

    const caller = String(
      identity?.uri?.user
      || parsedFrom?.uri?.user
      || 'Desconhecido'
    ).trim();

    const candidates = [
      this._extractNameForCaller(rawSip, caller),
      this._extractNameForCaller(headerBlob, caller),
      this._extractNameForCaller(fromRaw, caller),
      this._extractNameForCaller(paiRaw, caller),
      this._extractNameForCaller(rpidRaw, caller),
      this._extractNameForCaller(contactRaw, caller),
      this._extractDisplayName(identity, fromRaw),
      this._extractDisplayName(parsedFrom, fromRaw),
      this._extractDisplayName(req?.from, fromRaw),
      this._extractDisplayName(null, paiRaw),
      this._extractDisplayName(null, rpidRaw),
      this._extractDisplayName(null, contactRaw),
      this._extractDisplayName(null, callerNameRaw),
    ]
      .map((v) => String(v || '').trim())
      .filter((name) => this._isUsefulDisplayName(name, caller));

    const display = candidates[0] || caller;

    const identityDump = {
      caller,
      display,
      fromRaw,
      paiRaw: paiRaw || undefined,
      rpidRaw: rpidRaw || undefined,
      contactRaw: contactRaw || undefined,
      callerNameRaw: callerNameRaw || undefined,
      identityDisplayName: identity?.display_name ?? null,
      parsedFromDisplayName: parsedFrom?.display_name ?? null,
      candidates,
      headerNames: Object.keys(allHeaders),
      headers: allHeaders,
      rawSip: rawSip || undefined,
      rawSipPreview: rawSip ? rawSip.slice(0, 1200) : '',
    };

    dialLog('Identidade remota da chamada', identityDump);
    sipDebug.setLastIncomingIdentity(identityDump);

    return { caller, display };
  }

  _handleIncoming(session, request = null) {
    const { caller, display } = this._resolveRemoteParty(session, request);

    this.session = session;
    this._bindSessionEvents(session, 'primary');

    this.emit('incoming', { caller, display, sessionId: session.id });

    if (this.toggles.autoAnswer) {
      setTimeout(() => this.answer(), 500);
    } else {
      this._ringtone.start();
      dialLog('Toque de chamada recebida iniciado');
    }
  }

  _normalizeConfig(config = {}) {
    const sipUri = buildSipUri(config);
    const domain = String(config.domain || '').trim() || extractSipDomain(sipUri);
    return {
      ...config,
      websocketUrl: String(config.websocketUrl || '').trim(),
      sipUri,
      domain,
      extension: String(config.extension || '').trim(),
      displayName: String(config.displayName || '').trim(),
      password: config.password || '',
      stunUrl: String(config.stunUrl || '').trim(),
    };
  }

  _getPcConfig() {
    const stunUrl = this.sipConfig.stunUrl?.trim();
    const iceServers = stunUrl ? [{ urls: stunUrl }] : [];
    return {
      iceServers,
      iceCandidatePoolSize: iceServers.length ? 1 : 0,
    };
  }

  _stopRingback() {
    this._ringback.stop();
  }

  _stopRingtone() {
    this._ringtone.stop();
  }

  _ensureRemoteAudioElement() {
    if (!this.remoteAudio) {
      this.remoteAudio = document.getElementById('remote-audio');
      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement('audio');
        this.remoteAudio.id = 'remote-audio';
        this.remoteAudio.autoplay = true;
        this.remoteAudio.playsInline = true;
        this.remoteAudio.style.display = 'none';
        document.body.appendChild(this.remoteAudio);
      }
    }
    this.remoteAudio.autoplay = true;
    this.remoteAudio.muted = false;
    this.remoteAudio.volume = 1;
    return this.remoteAudio;
  }

  _attachRemoteAudio(session) {
    const pc = session?.connection;
    if (!pc) return false;

    const tracks = pc.getReceivers()
      .map((r) => r.track)
      .filter((t) => t && t.kind === 'audio');

    if (!tracks.length) return false;

    const stream = new MediaStream(tracks);
    const el = this._ensureRemoteAudioElement();
    el.srcObject = stream;

    const playPromise = el.play();
    if (playPromise) {
      playPromise.catch((err) => dialError('remoteAudio.play() falhou', err));
    }

    this._hasRemoteAudio = true;
    dialLog('Áudio remoto anexado ao alto-falante', {
      tracks: tracks.length,
      trackStates: tracks.map((t) => t.readyState),
    });

    this._startMeters(pc);
    return true;
  }

  _clearRemoteAudio() {
    this._hasRemoteAudio = false;
    const el = this.remoteAudio;
    if (!el) return;
    try {
      el.pause();
      el.srcObject = null;
    } catch {
      /* ignore */
    }
  }

  call(target, options = {}) {
    dialLog('call() iniciado', {
      target,
      registrationState: this.registrationState,
      wsState: this.wsState,
      domain: this.sipConfig.domain,
      isConsult: !!options.isConsult,
      hasActiveSession: !!this.session,
    });

    if (!this.ua || this.registrationState !== 'registered') {
      const err = new Error('Não registrado no servidor SIP.');
      dialError('call() bloqueado — não registrado', {
        hasUa: !!this.ua,
        registrationState: this.registrationState,
      });
      throw err;
    }
    if (this.session && !options.isConsult) {
      const err = new Error('Já existe uma chamada ativa.');
      dialError('call() bloqueado — chamada ativa', { sessionId: this.session.id });
      throw err;
    }

    let uri;
    try {
      uri = buildCallUri(target, this.sipConfig.domain);
    } catch (e) {
      dialError('call() URI inválida', e);
      throw e;
    }

    dialLog('call() URI de destino montada', { uri });

    this._hasRemoteAudio = false;
    this._stopRingback();

    const session = this.ua.call(uri, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: this._getPcConfig(),
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    });

    dialLog('call() sessão JsSIP criada', {
      sessionId: session?.id,
      direction: session?.direction,
    });

    if (options.isConsult) {
      this.consultSession = session;
      this._bindSessionEvents(session, 'consult');
    } else {
      this.session = session;
      this._bindSessionEvents(session, 'primary');
      this.emit('outgoing', { target, sessionId: session.id });
      dialLog('call() evento outgoing emitido', { target, sessionId: session.id });
    }

    return session;
  }

  answer() {
    if (!this.session || this.session.direction !== 'incoming') return;
    this._stopRingtone();
    this.session.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: this._getPcConfig(),
      rtcAnswerConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    });
  }

  reject() {
    if (!this.session || this.session.direction !== 'incoming') return;
    this._stopRingtone();
    this.session.terminate({ status_code: 486, reason_phrase: 'Rejected' });
  }

  hangup(sessionType = 'primary') {
    this._stopRingtone();
    this._stopRingback();
    const s = sessionType === 'consult' ? this.consultSession : this.session;
    if (s) s.terminate();
  }

  mute(muted) {
    if (!this.session) return;
    if (muted) this.session.mute({ audio: true });
    else this.session.unmute({ audio: true });
    this.emit('mute', { muted });
  }

  hold() {
    if (!this.session || this.session.isOnHold().local) return;
    this.session.hold();
    this.emit('hold', { held: true });
  }

  unhold() {
    if (!this.session || !this.session.isOnHold().local) return;
    this.session.unhold();
    this.emit('hold', { held: false });
  }

  sendDTMF(digit) {
    if (!this.session) return;
    this.session.sendDTMF(digit);
    this.emit('dtmf', { digit });
  }

  blindTransfer(target) {
    if (!this.session) throw new Error('Nenhuma chamada ativa.');
    const uri = buildCallUri(target, this.sipConfig.domain);
    this.session.refer(uri);
    this.emit('transfer', { type: 'blind', target });
  }

  startConsultation(target) {
    if (!this.session) throw new Error('Nenhuma chamada ativa.');
    this.session.hold();
    this.emit('hold', { held: true });
    return this.call(target, { isConsult: true });
  }

  completeAttendedTransfer() {
    if (!this.session || !this.consultSession) {
      throw new Error('Consulta não iniciada.');
    }
    const target = this.consultSession.remote_identity?.uri?.toString();
    this.consultSession.terminate();
    this.consultSession = null;
    this.session.refer(target);
    this.emit('transfer', { type: 'attended', target });
  }

  cancelConsultation() {
    if (this.consultSession) {
      this.consultSession.terminate();
      this.consultSession = null;
    }
    if (this.session?.isOnHold().local) {
      this.session.unhold();
      this.emit('hold', { held: false });
    }
  }

  swapToConsult() {
    if (!this.session || !this.consultSession) return;
    if (!this.session.isOnHold().local) this.session.hold();
    if (this.consultSession.isOnHold().local) this.consultSession.unhold();
  }

  _bindSessionEvents(session, type) {
    const logEvent = (name, extra = {}) => {
      dialLog(`sessão [${type}] → ${name}`, {
        sessionId: session.id,
        direction: session.direction,
        ...extra,
      });
    };

    session.on('progress', (e) => {
      const statusCode = Number(e?.response?.status_code) || 0;
      const body = String(e?.response?.body || '');
      // Early media real: 183 com SDP de áudio (não basta ter qualquer body)
      const hasEarlyMedia = statusCode === 183 && /(?:^|\r?\n)m=audio/im.test(body);

      logEvent('progress', {
        statusCode,
        reason: e?.response?.reason_phrase,
        hasEarlyMedia,
        bodyLength: body.length,
      });

      if (type !== 'primary') return;
      if (session.isEstablished?.() || session.isEnded?.()) return;

      if (session.direction === 'outgoing') {
        if (hasEarlyMedia) {
          this._stopRingback();
          this._attachRemoteAudio(session);
          dialLog('Early media detectado (183+SDP), ringback local pausado');
        } else if (!this._hasRemoteAudio) {
          this._ringback.start();
          dialLog('Ringback local iniciado', { statusCode });
        } else {
          this._stopRingback();
          dialLog('Áudio remoto já ativo, ringback local mantido pausado');
        }
      }

      this.emit('callState', { state: CallState.RINGING });
    });

    session.on('accepted', (e) => {
      this._stopRingback();
      this._stopRingtone();
      logEvent('accepted', {
        statusCode: e?.response?.status_code,
        reason: e?.response?.reason_phrase,
      });
      this._attachRemoteAudio(session);
      if (type === 'primary') this.emit('callState', { state: CallState.CONNECTED });
      if (type === 'consult') this.emit('consultState', { state: CallState.CONNECTED });
    });

    session.on('confirmed', () => {
      this._stopRingback();
      this._stopRingtone();
      logEvent('confirmed');
      this._attachRemoteAudio(session);
      if (type === 'primary') {
        this.emit('callState', { state: CallState.CONNECTED });
        if (this.toggles.autoRecord) this._startRecording();
      }
    });

    session.on('hold', () => {
      logEvent('hold');
      if (type === 'primary') this.emit('callState', { state: CallState.HELD });
    });

    session.on('unhold', () => {
      logEvent('unhold');
      if (type === 'primary') this.emit('callState', { state: CallState.CONNECTED });
    });

    session.on('ended', (e) => {
      this._stopRingback();
      this._stopRingtone();
      logEvent('ended', {
        originator: e?.originator,
        cause: e?.cause,
        statusCode: e?.message?.status_code,
        reason: e?.message?.reason_phrase,
      });
      this._stopRecording();
      this._stopMeters();
      this._clearRemoteAudio();
      if (type === 'consult') {
        this.consultSession = null;
        this.emit('consultState', { state: CallState.ENDED });
      } else {
        this.emit('callEnded', { sessionId: session.id });
        this.session = null;
        this.emit('callState', { state: CallState.ENDED });
      }
      this.emit('diagnostics', this.getDiagnostics());
    });

    session.on('failed', (e) => {
      this._stopRingback();
      this._stopRingtone();
      const cause = e?.cause || e?.message || 'Falha na chamada';
      dialError(`sessão [${type}] → failed`, {
        cause,
        originator: e?.originator,
        statusCode: e?.message?.status_code,
        reason: e?.message?.reason_phrase,
        message: e?.message,
      });
      this._stopRecording();
      this._stopMeters();
      this._clearRemoteAudio();
      if (type === 'consult') {
        this.consultSession = null;
        this.emit('consultState', { state: CallState.ENDED, cause });
      } else {
        this.session = null;
        this.emit('callFailed', { cause });
        this.emit('callState', { state: CallState.ENDED, cause });
        this.emit('callEnded', { sessionId: session.id, cause });
      }
      this.emit('diagnostics', this.getDiagnostics());
    });

    session.on('peerconnection', (data) => {
      const pc = data.peerconnection;
      logEvent('peerconnection', { signalingState: pc.signalingState });
      pc.addEventListener('iceconnectionstatechange', () => {
        this.iceState = pc.iceConnectionState;
        dialLog(`ICE [${type}]`, { state: this.iceState, sessionId: session.id });
        this.emit('ice', { state: this.iceState });
        this.emit('diagnostics', this.getDiagnostics());
      });
      pc.addEventListener('icegatheringstatechange', () => {
        dialLog(`ICE gathering [${type}]`, { state: pc.iceGatheringState });
      });
      pc.addEventListener('connectionstatechange', () => {
        dialLog(`RTCPeerConnection [${type}]`, { state: pc.connectionState });
      });
      pc.addEventListener('track', (ev) => {
        if (ev.track.kind === 'audio') {
          this._stopRingback();
          logEvent('track audio recebido', { trackId: ev.track.id, enabled: ev.track.enabled });
          this._attachRemoteAudio(session);
          this.emit('diagnostics', this.getDiagnostics());
        }
      });
    });

    session.on('getusermediafailed', (e) => {
      dialError(`sessão [${type}] → getusermediafailed`, e);
      this.emit('error', { message: `Falha ao acessar microfone: ${e}` });
    });

    session.on('sdp', (e) => {
      dialLog(`sessão [${type}] → sdp`, { originator: e?.originator, type: e?.type });
    });
  }

  _startMeters(pc) {
    this._stopMeters();
    if (!pc) return;

    try {
      const audioCtx = new AudioContext();
      const analyserLocal = audioCtx.createAnalyser();
      analyserLocal.fftSize = 256;

      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender?.track) {
        const localSource = audioCtx.createMediaStreamSource(new MediaStream([sender.track]));
        localSource.connect(analyserLocal);
      }

      const localData = new Uint8Array(analyserLocal.frequencyBinCount);

      this._meterInterval = setInterval(async () => {
        analyserLocal.getByteFrequencyData(localData);
        const localLevel = this._avgLevel(localData);
        let remoteLevel = 0;

        try {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
              if (typeof report.audioLevel === 'number') {
                remoteLevel = Math.max(remoteLevel, Math.round(report.audioLevel * 100));
              } else if (typeof report.bytesReceived === 'number' && report.bytesReceived > 0) {
                remoteLevel = Math.max(remoteLevel, 5);
              }
            }
          });
        } catch {
          /* stats optional */
        }

        this.emit('meters', { local: localLevel, remote: remoteLevel });
      }, 200);

      this._audioCtx = audioCtx;
    } catch {
      /* meters optional */
    }
  }

  _avgLevel(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return Math.round((sum / data.length / 255) * 100);
  }

  _stopMeters() {
    if (this._meterInterval) {
      clearInterval(this._meterInterval);
      this._meterInterval = null;
    }
    if (this._audioCtx) {
      this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
  }

  _startRecording() {
    try {
      const stream = this.remoteAudio.srcObject;
      if (!stream) return;
      this.recordedChunks = [];
      this.mediaRecorder = new MediaRecorder(stream);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.mediaRecorder.start(1000);
      this.emit('recording', { active: true });
    } catch {
      /* recording optional */
    }
  }

  _stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.emit('recording', { active: false, chunks: this.recordedChunks });
    }
    this.mediaRecorder = null;
  }

  async getPermissionStatus() {
    try {
      const mic = await navigator.permissions.query({ name: 'microphone' });
      return { microphone: mic.state };
    } catch {
      return { microphone: 'unknown' };
    }
  }

  getDiagnostics() {
    const pc = this.session?.connection;
    const tracks = [];
    if (pc) {
      pc.getSenders().forEach((s) => {
        if (s.track) tracks.push({ direction: 'send', kind: s.track.kind, label: s.track.label, enabled: s.track.enabled });
      });
      pc.getReceivers().forEach((r) => {
        if (r.track) tracks.push({ direction: 'recv', kind: r.track.kind, label: r.track.label, enabled: r.track.enabled });
      });
    }
    return {
      registration: this.registrationState,
      websocket: this.wsState,
      ice: this.iceState,
      tracks,
      hasActiveCall: !!this.session,
      hasConsult: !!this.consultSession,
      uaStatus: this.ua ? (this.ua.isConnected() ? 'connected' : 'disconnected') : 'stopped',
    };
  }

  async testMicrophone(onLevel) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      onLevel(this._avgLevel(data));
    }, 100);
    return () => {
      clearInterval(interval);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    };
  }

  async testSpeaker() {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 440;
    gain.gain.value = 0.1;
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 1000);
  }
}

export const sipClient = new SipClient();
