const puppeteer = require('puppeteer');
const path = require('path');
const config = require('../config');
const SignatureGenerator = require('../services/SignatureGenerator');
const logger = require('../services/logger');

/**
 * ZoomBot - Uma instância de bot que entra em uma reunião Zoom via Puppeteer
 * e monitora o estado de câmera/mic dos participantes.
 *
 * Ciclo de vida: create -> join -> (monitorando) -> leave -> destroy
 */
class ZoomBot {
  constructor(meetingNumber, eventSender) {
    this.meetingNumber = String(meetingNumber);
    this.eventSender = eventSender;
    this.botId = `bot-${meetingNumber}-${Date.now()}`;
    this.browser = null;
    this.page = null;
    this.status = 'idle'; // idle, joining, connected, leaving, stopped, error
    this.heartbeatTimer = null;
    this.eventDrainTimer = null;
    this.startedAt = null;
    this.log = logger.child({ botId: this.botId, meeting: meetingNumber });
  }

  /**
   * Inicia o bot: abre browser headless, carrega SDK, entra na reunião.
   */
  async join() {
    if (this.status !== 'idle') {
      throw new Error(`Bot ${this.botId} não está idle (status: ${this.status})`);
    }

    this.status = 'joining';
    this.startedAt = new Date();
    this.log.info('Iniciando bot...');

    try {
      // Gerar signature para o Meeting SDK
      const signature = SignatureGenerator.generate(this.meetingNumber, 0);

      // Lançar Puppeteer
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          // Permissões de mídia (o bot não usa camera/mic, mas o SDK precisa)
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          // Desabilitar extensões e features desnecessárias
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-features=TranslateUI',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-popup-blocking',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-sync',
          '--metrics-recording-only',
          '--mute-audio',
        ],
      });

      this.page = await this.browser.newPage();

      // Configurar viewport mínimo (bot não precisa de UI grande)
      await this.page.setViewport({ width: 800, height: 600 });

      // Dar permissão de mídia (necessário para o SDK)
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions('file://', ['microphone', 'camera']);

      // Carregar a página do bot
      const botHtmlPath = path.join(__dirname, 'bot-client.html');
      await this.page.goto(`file://${botHtmlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

      // Injetar configuração
      await this.page.evaluate((cfg) => {
        window.__BOT_CONFIG__ = cfg;
      }, {
        meetingNumber: this.meetingNumber,
        signature,
        sdkKey: config.zoom.sdkKey,
        userName: config.bot.name,
        userEmail: config.bot.email,
        password: '',
        pollIntervalMs: config.performance.pollIntervalMs,
      });

      this.log.info('Config injetada, aguardando conexão com a reunião...');

      // Aguardar o bot conectar (máximo 60 segundos)
      const connected = await this.waitForStatus('connected', 60000);
      if (!connected) {
        const currentStatus = await this.getBotStatus();
        throw new Error(`Bot não conectou após 60s (status: ${currentStatus})`);
      }

      this.status = 'connected';
      this.log.info('Bot conectado à reunião');

      // Iniciar drenagem de eventos
      this.startEventDrain();

      // Iniciar heartbeat
      this.startHeartbeat();

      return true;
    } catch (err) {
      this.status = 'error';
      this.log.error(`Erro ao iniciar bot: ${err.message}`);
      await this.destroy();
      throw err;
    }
  }

  /**
   * Sai da reunião e fecha o browser.
   */
  async leave() {
    if (this.status === 'stopped' || this.status === 'idle') return;

    this.status = 'leaving';
    this.log.info('Saindo da reunião...');

    // Drenar eventos restantes antes de sair
    await this.drainEvents();

    this.stopHeartbeat();
    this.stopEventDrain();

    try {
      if (this.page) {
        await this.page.evaluate(() => {
          try { ZoomMtg.leaveMeeting({}); } catch (e) { /* ignore */ }
        }).catch(() => {});
      }
    } catch (e) { /* ignore */ }

    await this.destroy();
    this.status = 'stopped';
    this.log.info('Bot desconectado');
  }

  /**
   * Fecha o browser e limpa recursos.
   */
  async destroy() {
    this.stopHeartbeat();
    this.stopEventDrain();

    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (e) {
      this.log.warn(`Erro ao fechar browser: ${e.message}`);
    }

    this.browser = null;
    this.page = null;
  }

  /**
   * Drena eventos do buffer do browser e envia para o backend.
   */
  async drainEvents() {
    if (!this.page || this.status === 'stopped') return;

    try {
      const events = await this.page.evaluate(() => {
        const evts = window.__BOT_EVENTS__ || [];
        window.__BOT_EVENTS__ = [];
        return evts;
      });

      if (events.length > 0) {
        this.log.info(`Drenando ${events.length} eventos`);
        await this.eventSender.sendBatch(events);
      }
    } catch (err) {
      this.log.error(`Erro ao drenar eventos: ${err.message}`);
    }
  }

  /**
   * Retorna informações de status do bot.
   */
  async getInfo() {
    const participants = this.page
      ? await this.page.evaluate(() => window.__BOT_PARTICIPANTS__ || {}).catch(() => ({}))
      : {};

    return {
      botId: this.botId,
      meetingNumber: this.meetingNumber,
      status: this.status,
      startedAt: this.startedAt?.toISOString(),
      participantCount: Object.keys(participants).length,
      participants,
    };
  }

  // ──── Internos ────

  async getBotStatus() {
    if (!this.page) return 'no_page';
    return this.page.evaluate(() => window.__BOT_STATUS__).catch(() => 'unknown');
  }

  async waitForStatus(target, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.getBotStatus();
      if (status === target) return true;
      if (status === 'error') return false;
      if (status === 'meeting_ended') return false;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  startEventDrain() {
    this.eventDrainTimer = setInterval(
      () => this.drainEvents(),
      config.performance.eventBufferFlushMs
    );
  }

  stopEventDrain() {
    if (this.eventDrainTimer) {
      clearInterval(this.eventDrainTimer);
      this.eventDrainTimer = null;
    }
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        const info = await this.getInfo();
        await this.eventSender.sendHeartbeat({
          meeting_id: this.meetingNumber,
          bot_id: this.botId,
          participant_count: info.participantCount,
          status: this.status,
        });
      } catch (err) {
        this.log.warn(`Heartbeat falhou: ${err.message}`);
      }
    }, config.performance.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Monitora se a reunião foi encerrada (pelo host).
   * Chamado periodicamente pelo BotManager.
   */
  async checkMeetingEnded() {
    if (!this.page || this.status !== 'connected') return false;

    try {
      const botStatus = await this.getBotStatus();
      if (botStatus === 'meeting_ended') {
        this.log.info('Reunião encerrada detectada');
        await this.drainEvents(); // Drenar eventos finais
        return true;
      }
    } catch (e) {
      // Page pode ter sido fechada
      return true;
    }

    return false;
  }
}

module.exports = ZoomBot;
