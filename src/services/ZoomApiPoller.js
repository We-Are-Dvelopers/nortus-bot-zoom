const fetch = require('node-fetch');
const config = require('../config');
const logger = require('./logger');

/**
 * ZoomApiPoller - Faz polling da Zoom REST API para obter status de vídeo/áudio.
 *
 * Usa a API de listagem de participantes ao vivo para detectar
 * quem está com câmera on/off sem depender do SDK headless.
 */
class ZoomApiPoller {
  constructor(eventSender) {
    this.eventSender = eventSender;
    this.pollers = new Map(); // meetingId -> intervalId
    this.previousState = new Map(); // meetingId -> { userName: { video, audio } }
    this.tokenCache = { token: null, expiresAt: 0 };
    this.log = logger.child({ component: 'ZoomApiPoller' });
  }

  /**
   * Inicia polling para uma reunião.
   */
  startPolling(meetingId) {
    if (this.pollers.has(meetingId)) return;

    this.log.info(`Iniciando polling de câmera para meeting ${meetingId}`);
    this.previousState.set(meetingId, {});

    const interval = setInterval(() => this.pollMeeting(meetingId), config.performance.pollIntervalMs);
    this.pollers.set(meetingId, interval);

    // Primeiro poll imediato
    this.pollMeeting(meetingId);
  }

  /**
   * Para polling para uma reunião.
   */
  stopPolling(meetingId) {
    const interval = this.pollers.get(meetingId);
    if (interval) {
      clearInterval(interval);
      this.pollers.delete(meetingId);
      this.previousState.delete(meetingId);
      this.log.info(`Polling parado para meeting ${meetingId}`);
    }
  }

  /**
   * Consulta participantes ao vivo via Zoom API.
   */
  async pollMeeting(meetingId) {
    try {
      const token = await this.getS2SToken();
      if (!token) return;

      // Tentar a API de listagem de participantes ao vivo
      const url = `https://api.zoom.us/v2/meetings/${meetingId}/participants?status=in_meeting&page_size=300`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (response.status === 200) {
        const data = await response.json();
        this.processParticipants(meetingId, data.participants || []);
      } else if (response.status === 400 || response.status === 404) {
        // API não disponível neste plano ou reunião não encontrada - tentar past participants
        // Silenciar - já sabemos que não funciona
      } else {
        const text = await response.text();
        this.log.warn(`Zoom API ${response.status}: ${text.substring(0, 200)}`);
      }
    } catch (err) {
      this.log.error(`Erro no polling: ${err.message}`);
    }
  }

  /**
   * Processa a lista de participantes e detecta mudanças de câmera.
   */
  processParticipants(meetingId, participants) {
    const prevState = this.previousState.get(meetingId) || {};
    const currentState = {};

    for (const p of participants) {
      const name = p.user_name || p.name || 'Desconhecido';
      const videoOn = p.camera === 'on' || p.video === 'on' || p.share_camera === true;
      const audioOn = p.microphone === 'on' || p.audio === 'on';

      currentState[name] = { videoOn, audioOn };

      const prev = prevState[name];
      if (prev) {
        // Detectar mudança de câmera
        if (prev.videoOn !== videoOn) {
          this.eventSender.queue({
            event_type: videoOn ? 'camera_on' : 'camera_off',
            timestamp: new Date().toISOString(),
            meeting_id: meetingId,
            user_name: name,
            user_email: p.user_email || p.email || '',
            participant_id: p.registrant_id || '',
            extra: { source: 'zoom_api_poll' },
          });
          this.log.info(`Camera ${videoOn ? 'ON' : 'OFF'}: ${name} (meeting ${meetingId})`);
        }

        // Detectar mudança de mic
        if (prev.audioOn !== audioOn) {
          this.eventSender.queue({
            event_type: audioOn ? 'mic_on' : 'mic_off',
            timestamp: new Date().toISOString(),
            meeting_id: meetingId,
            user_name: name,
            user_email: p.user_email || p.email || '',
            participant_id: p.registrant_id || '',
            extra: { source: 'zoom_api_poll' },
          });
        }
      }
    }

    this.previousState.set(meetingId, currentState);
  }

  /**
   * Obtém token S2S OAuth (cacheado).
   */
  async getS2SToken() {
    if (this.tokenCache.token && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    try {
      const accountId = config.zoom.s2sAccountId;
      const clientId = config.zoom.s2sClientId;
      const clientSecret = config.zoom.s2sClientSecret;

      if (!accountId || !clientId || !clientSecret) {
        this.log.warn('Zoom S2S credentials não configuradas');
        return null;
      }

      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const response = await fetch(
        `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
        {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}` },
          timeout: 10000,
        }
      );

      if (response.ok) {
        const data = await response.json();
        this.tokenCache = {
          token: data.access_token,
          expiresAt: Date.now() + (data.expires_in - 60) * 1000,
        };
        return data.access_token;
      }
    } catch (err) {
      this.log.error(`Erro ao obter S2S token: ${err.message}`);
    }
    return null;
  }

  /**
   * Para todos os pollers.
   */
  shutdown() {
    for (const [meetingId] of this.pollers) {
      this.stopPolling(meetingId);
    }
  }
}

module.exports = ZoomApiPoller;
