const puppeteer = require('puppeteer');
const path = require('path');
const http = require('http');
const fs = require('fs');
const config = require('../config');
const SignatureGenerator = require('../services/SignatureGenerator');
const logger = require('../services/logger');

// Servidor HTTP local para servir o bot-client.html
// (file:// bloqueia scripts de CDN por política de segurança)
let localServer = null;
let localServerPort = 0;

function ensureLocalServer() {
  return new Promise((resolve, reject) => {
    if (localServer) {
      return resolve(localServerPort);
    }

    const botHtmlPath = path.join(__dirname, 'bot-client.html');
    const htmlContent = fs.readFileSync(botHtmlPath, 'utf-8');

    localServer = http.createServer((req, res) => {
      // Headers COOP/COEP para habilitar SharedArrayBuffer
      // Necessário para o SDK renderizar vídeo dos participantes
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(htmlContent);
    });

    localServer.listen(0, '127.0.0.1', () => {
      localServerPort = localServer.address().port;
      logger.info(`Local HTML server rodando em http://127.0.0.1:${localServerPort}`);
      resolve(localServerPort);
    });

    localServer.on('error', reject);
  });
}

/**
 * ZoomBot - Uma instância de bot que entra em uma reunião Zoom via Puppeteer
 * e monitora o estado de câmera/mic dos participantes.
 */
class ZoomBot {
  constructor(meetingNumber, eventSender) {
    this.meetingNumber = String(meetingNumber);
    this.eventSender = eventSender;
    this.botId = `bot-${meetingNumber}-${Date.now()}`;
    this.browser = null;
    this.page = null;
    this.status = 'idle';
    this.heartbeatTimer = null;
    this.eventDrainTimer = null;
    this.startedAt = null;
    this.log = logger.child({ botId: this.botId, meeting: meetingNumber });
  }

  async join() {
    if (this.status !== 'idle') {
      throw new Error(`Bot ${this.botId} não está idle (status: ${this.status})`);
    }

    this.status = 'joining';
    this.startedAt = new Date();
    this.log.info('Iniciando bot...');

    try {
      const signature = SignatureGenerator.generate(this.meetingNumber, 0);

      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          // Permissões de mídia
          '--use-fake-ui-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          // Mínimo de flags - não bloquear rede/WebSocket
          '--disable-extensions',
          '--disable-popup-blocking',
          '--mute-audio',
        ],
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 800, height: 600 });

      // Capturar TODOS os logs do console do browser
      this.page.on('console', (msg) => {
        const text = msg.text();
        this.log.info(`[BROWSER ${msg.type()}] ${text}`);
      });

      // Capturar erros de página
      this.page.on('pageerror', (err) => {
        this.log.error(`[BROWSER ERROR] ${err.message}`);
      });

      // Capturar requests que falharam
      this.page.on('requestfailed', (req) => {
        this.log.warn(`[BROWSER] Request falhou: ${req.url()} - ${req.failure()?.errorText}`);
      });

      // Dar permissão de mídia
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions('http://127.0.0.1', ['microphone', 'camera']);

      // Servir o HTML via HTTP local (file:// bloqueia CDN scripts)
      const port = await ensureLocalServer();
      this.log.info(`Carregando bot page de http://127.0.0.1:${port}`);
      await this.page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0', timeout: 30000 });

      // Verificar se o SDK carregou
      const sdkLoaded = await this.page.evaluate(() => typeof ZoomMtg !== 'undefined');
      this.log.info(`SDK carregado: ${sdkLoaded}`);

      if (!sdkLoaded) {
        throw new Error('Zoom Meeting SDK não carregou - verifique conexão com CDN');
      }

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

      // Aguardar o bot conectar (máximo 90 segundos)
      const connected = await this.waitForStatus('connected', 90000);
      if (!connected) {
        const currentStatus = await this.getBotStatus();
        // Capturar estado da página para debug
        const pageStatus = await this.page.evaluate(() => {
          return {
            botStatus: window.__BOT_STATUS__,
            statusText: document.getElementById('status')?.textContent,
            errors: window.__BOT_ERRORS__ || [],
            bodyHTML: document.body.innerHTML.substring(0, 2000),
          };
        }).catch(() => ({}));
        this.log.error(`Debug page state: ${JSON.stringify(pageStatus)}`);
        // Screenshot para debug visual
        try {
          await this.page.screenshot({ path: `/tmp/zoom-bot-debug-${this.meetingNumber}.png`, fullPage: true });
          this.log.info(`Screenshot salvo em /tmp/zoom-bot-debug-${this.meetingNumber}.png`);
        } catch (e) { /* ignore */ }
        throw new Error(`Bot não conectou após 90s (status: ${currentStatus})`);
      }

      this.status = 'connected';
      this.log.info('Bot conectado à reunião');

      // Clicar em "Join Audio by Computer" e mutar via Puppeteer
      await this.muteBot();

      this.startEventDrain();
      this.startHeartbeat();

      return true;
    } catch (err) {
      this.status = 'error';
      this.log.error(`Erro ao iniciar bot: ${err.message}`);
      await this.destroy();
      throw err;
    }
  }

  async leave() {
    if (this.status === 'stopped' || this.status === 'idle') return;

    this.status = 'leaving';
    this.log.info('Saindo da reunião...');

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

  async muteBot() {
    if (!this.page) return;
    try {
      // Tentar mutar imediatamente
      await this.page.evaluate(() => {
        try { ZoomMtg.mute({ mute: true }); } catch(e) {}
        try { ZoomMtg.muteVideo({ mute: true }); } catch(e) {}
      });

      // Esperar SDK renderizar e tentar de novo
      await new Promise(r => setTimeout(r, 2000));

      await this.page.evaluate(() => {
        // Clicar em botões de áudio se aparecerem
        const selectors = [
          '.join-audio-by-voip',
          'button[data-type="Computer Audio"]',
          '.join-audio-container button',
          '.join-dialog .btn-primary',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); break; }
        }

        // Forçar mute de novo
        try { ZoomMtg.mute({ mute: true }); } catch(e) {}
        try { ZoomMtg.muteVideo({ mute: true }); } catch(e) {}

        // Clicar no botão de parar vídeo se existir
        const stopVideoBtn = document.querySelector('.send-video-container__btn--stop-video, .footer-button__stop-video, button[aria-label="stop sending my video"]');
        if (stopVideoBtn) stopVideoBtn.click();
      });

      this.log.info('Bot mutado (áudio + vídeo)');
    } catch (err) {
      this.log.warn(`Erro ao mutar bot: ${err.message}`);
    }
  }

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

  async checkMeetingEnded() {
    if (!this.page || this.status !== 'connected') return false;

    try {
      const botStatus = await this.getBotStatus();
      if (botStatus === 'meeting_ended') {
        this.log.info('Reunião encerrada detectada');
        await this.drainEvents();
        return true;
      }
    } catch (e) {
      return true;
    }

    return false;
  }
}

module.exports = ZoomBot;
