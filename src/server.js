const express = require('express');
const config = require('./config');
const BotManager = require('./bot/BotManager');
const EventSender = require('./services/EventSender');
const ZoomApiPoller = require('./services/ZoomApiPoller');
const logger = require('./services/logger');

const app = express();
app.use(express.json());

// ── Instâncias globais ──
const eventSender = new EventSender();
const botManager = new BotManager(eventSender);
const zoomApiPoller = new ZoomApiPoller(eventSender);

// ── Middleware de autenticação ──
function authMiddleware(req, res, next) {
  const secret = req.headers['x-bot-secret'] || req.query.secret;
  if (!secret || secret !== config.api.botSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── ROTAS ──

/**
 * POST /bots
 * Inicia um bot para monitorar uma reunião.
 * Body: { meeting_number: "123456789" }
 */
app.post('/bots', authMiddleware, async (req, res) => {
  try {
    const { meeting_number } = req.body;
    if (!meeting_number) {
      return res.status(400).json({ error: 'meeting_number é obrigatório' });
    }

    logger.info(`API: Requisição para criar bot na meeting ${meeting_number}`);
    const info = await botManager.addBot(meeting_number);
    // Iniciar polling de câmera via Zoom API em paralelo
    zoomApiPoller.startPolling(meeting_number);
    res.status(201).json(info);
  } catch (err) {
    logger.error(`API: Erro ao criar bot: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /bots/:meetingNumber
 * Remove um bot de uma reunião.
 */
app.delete('/bots/:meetingNumber', authMiddleware, async (req, res) => {
  try {
    const removed = await botManager.removeBot(req.params.meetingNumber);
    zoomApiPoller.stopPolling(req.params.meetingNumber);
    if (!removed) {
      return res.status(404).json({ error: 'Bot não encontrado para esta reunião' });
    }
    res.json({ message: 'Bot removido' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /bots
 * Lista todos os bots ativos.
 */
app.get('/bots', authMiddleware, async (req, res) => {
  try {
    const status = await botManager.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /bots/:meetingNumber
 * Status de um bot específico.
 */
app.get('/bots/:meetingNumber', authMiddleware, async (req, res) => {
  try {
    const info = await botManager.getBotInfo(req.params.meetingNumber);
    if (!info) {
      return res.status(404).json({ error: 'Bot não encontrado' });
    }
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /health
 * Health check do serviço (sem auth).
 */
app.get('/health', async (req, res) => {
  const status = await botManager.getStatus();
  res.json({
    service: 'zoom-presence-bot',
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    bots: {
      active: status.totalBots,
      max: status.maxBots,
    },
  });
});

// ── Startup ──
const PORT = config.bot.port;

app.listen(PORT, () => {
  logger.info(`Zoom Presence Bot rodando na porta ${PORT}`);
  logger.info(`API Backend: ${config.api.baseUrl}`);
  logger.info(`Max bots simultâneos: ${config.performance.maxConcurrentBots}`);
  logger.info(`Poll interval: ${config.performance.pollIntervalMs}ms`);
});

// ── Graceful Shutdown ──
async function shutdown(signal) {
  logger.info(`${signal} recebido. Encerrando...`);

  try {
    await eventSender.shutdown();
    zoomApiPoller.shutdown();
    await botManager.shutdown();
    logger.info('Shutdown completo');
    process.exit(0);
  } catch (err) {
    logger.error(`Erro no shutdown: ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});
