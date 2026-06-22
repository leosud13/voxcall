import JsSIP from 'jssip';
import { generateId } from './utils.js';

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
    this.remoteAudio = new Audio();
    this.remoteAudio.autoplay = true;
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
    this.sipConfig = config;
    this.toggles = toggles;

    if (!config.websocketUrl || !config.sipUri) {
      throw new Error('URL WebSocket e URI SIP são obrigatórios.');
    }

    const socket = new JsSIP.WebSocketInterface(config.websocketUrl);
    socket.via_transport = 'WSS';

    const uri = config.sipUri.includes('@') ? config.sipUri : `${config.extension}@${config.domain}`;
    const sipUri = uri.startsWith('sip:') ? uri : `sip:${uri}`;

    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: sipUri,
      password: config.password,
      display_name: config.displayName || config.extension,
      register: true,
      session_timers: false,
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 30,
    });

    this._bindUaEvents();
    this.ua.start();
    this.emit('state', { registration: 'registering', ws: 'connecting' });
  }

  disconnect() {
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
      if (session.direction === 'incoming') {
        if (this.session && this.toggles.callWaiting) {
          this._handleIncoming(session);
        } else if (!this.session) {
          this._handleIncoming(session);
        } else {
          session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
        }
      }
    });
  }

  _handleIncoming(session) {
    const caller = session.remote_identity?.uri?.user || 'Desconhecido';
    const display = session.remote_identity?.display_name || caller;

    this.session = session;
    this._bindSessionEvents(session, 'primary');

    this.emit('incoming', { caller, display, sessionId: session.id });

    if (this.toggles.autoAnswer) {
      setTimeout(() => this.answer(), 500);
    }
  }

  call(target, options = {}) {
    if (!this.ua || this.registrationState !== 'registered') {
      throw new Error('Não registrado no servidor SIP.');
    }
    if (this.session && !options.isConsult) {
      throw new Error('Já existe uma chamada ativa.');
    }

    const domain = this.sipConfig.domain;
    const uri = target.includes('@')
      ? (target.startsWith('sip:') ? target : `sip:${target}`)
      : `sip:${target}@${domain}`;

    const session = this.ua.call(uri, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
      eventHandlers: {},
    });

    if (options.isConsult) {
      this.consultSession = session;
      this._bindSessionEvents(session, 'consult');
    } else {
      this.session = session;
      this._bindSessionEvents(session, 'primary');
      this.emit('outgoing', { target, sessionId: session.id });
    }

    return session;
  }

  answer() {
    if (!this.session || this.session.direction !== 'incoming') return;
    this.session.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
    });
  }

  reject() {
    if (!this.session || this.session.direction !== 'incoming') return;
    this.session.terminate({ status_code: 486, reason_phrase: 'Rejected' });
  }

  hangup(sessionType = 'primary') {
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
    const domain = this.sipConfig.domain;
    const uri = target.includes('@')
      ? (target.startsWith('sip:') ? target : `sip:${target}`)
      : `sip:${target}@${domain}`;
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
    session.on('progress', () => {
      if (type === 'primary') this.emit('callState', { state: CallState.RINGING });
    });

    session.on('accepted', () => {
      if (type === 'primary') this.emit('callState', { state: CallState.CONNECTED });
      if (type === 'consult') this.emit('consultState', { state: CallState.CONNECTED });
    });

    session.on('confirmed', () => {
      if (type === 'primary') {
        this.emit('callState', { state: CallState.CONNECTED });
        if (this.toggles.autoRecord) this._startRecording();
      }
    });

    session.on('hold', () => {
      if (type === 'primary') this.emit('callState', { state: CallState.HELD });
    });

    session.on('unhold', () => {
      if (type === 'primary') this.emit('callState', { state: CallState.CONNECTED });
    });

    session.on('ended', () => {
      this._stopRecording();
      this._stopMeters();
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
      if (type === 'consult') {
        this.consultSession = null;
        this.emit('consultState', { state: CallState.ENDED, cause: e.cause });
      } else {
        this.session = null;
        this.emit('callState', { state: CallState.ENDED, cause: e.cause });
      }
    });

    session.on('peerconnection', (data) => {
      const pc = data.peerconnection;
      pc.addEventListener('iceconnectionstatechange', () => {
        this.iceState = pc.iceConnectionState;
        this.emit('ice', { state: this.iceState });
        this.emit('diagnostics', this.getDiagnostics());
      });
      pc.addEventListener('track', (ev) => {
        if (ev.track.kind === 'audio') {
          const stream = ev.streams[0] || new MediaStream([ev.track]);
          this.remoteAudio.srcObject = stream;
          this._startMeters(pc, stream);
          this.emit('diagnostics', this.getDiagnostics());
        }
      });
    });

    session.on('getusermediafailed', (e) => {
      this.emit('error', { message: `Falha ao acessar microfone: ${e}` });
    });
  }

  _startMeters(pc, remoteStream) {
    this._stopMeters();
    let audioCtx;
    try {
      audioCtx = new AudioContext();
      const analyserLocal = audioCtx.createAnalyser();
      const analyserRemote = audioCtx.createAnalyser();
      analyserLocal.fftSize = 256;
      analyserRemote.fftSize = 256;

      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        this.localStream = stream;
        const localSource = audioCtx.createMediaStreamSource(stream);
        localSource.connect(analyserLocal);
      }).catch(() => {});

      if (remoteStream) {
        const remoteSource = audioCtx.createMediaStreamSource(remoteStream);
        remoteSource.connect(analyserRemote);
      }

      const localData = new Uint8Array(analyserLocal.frequencyBinCount);
      const remoteData = new Uint8Array(analyserRemote.frequencyBinCount);

      this._meterInterval = setInterval(() => {
        analyserLocal.getByteFrequencyData(localData);
        analyserRemote.getByteFrequencyData(remoteData);
        const localLevel = this._avgLevel(localData);
        const remoteLevel = this._avgLevel(remoteData);
        this.emit('meters', { local: localLevel, remote: remoteLevel });
      }, 100);

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
