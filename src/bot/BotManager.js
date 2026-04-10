const ZoomBot = require('./ZoomBot');
const config = require('../config');
const logger = require('../services/logger');

/**
 * BotManager - Gerencia múltiplos bots simultâneos.
 *
 * Responsabilidades:
 * - Criar/destruir bots para reuniões
 * - Limitar número de bots simultâneos
 * - Monitorar saúde dos bots
 * - Auto-cleanup quando reunião termina
 */
class BotManager {
  constructor(eventSender) {
    this.eventSender = eventSender;
    this.bots = new Map(); // meetingNumber -> ZoomBot
    this.healthCheckTimer = null;
    this.log = logger.child({ component: 'BotManager' });

    // Iniciar health check a cada 30 segundos
    this.healthCheckTimer = setInterval(() => this.healthCheck(), 30000);
  }

  /**
   * Adiciona um bot para monitorar uma reunião.
   */
  async addBot(meetingNumber) {
    meetingNumber = String(meetingNumber);

    // Verificar se já existe bot para esta reunião
    if (this.bots.has(meetingNumber)) {
      const existing = this.bots.get(meetingNumber);
      if (existing.status === 'connected' || existing.status === 'joining') {
        this.log.warn(`Bot já existe para meeting ${meetingNumber} (status: ${existing.status})`);
        return existing.getInfo();
      }
      // Se está em outro estado, remover e recriar
      await this.removeBot(meetingNumber);
    }

    // Verificar limite de bots simultâneos
    const activeBots = [...this.bots.values()].filter(
      b => b.status === 'connected' || b.status === 'joining'
    ).length;

    if (activeBots >= config.performance.maxConcurrentBots) {
      throw new Error(
        `Limite de ${config.performance.maxConcurrentBots} bots simultâneos atingido (${activeBots} ativos)`
      );
    }

    // Criar e iniciar o bot
    const bot = new ZoomBot(meetingNumber, this.eventSender);
    this.bots.set(meetingNumber, bot);

    this.log.info(`Criando bot para meeting ${meetingNumber} (${activeBots + 1}/${config.performance.maxConcurrentBots})`);

    try {
      await bot.join();
      return bot.getInfo();
    } catch (err) {
      this.bots.delete(meetingNumber);
      throw err;
    }
  }

  /**
   * Remove um bot de uma reunião.
   */
  async removeBot(meetingNumber) {
    meetingNumber = String(meetingNumber);
    const bot = this.bots.get(meetingNumber);
    if (!bot) return false;

    this.log.info(`Removendo bot da meeting ${meetingNumber}`);

    try {
      await bot.leave();
    } catch (err) {
      this.log.error(`Erro ao remover bot: ${err.message}`);
      await bot.destroy();
    }

    this.bots.delete(meetingNumber);
    return true;
  }

  /**
   * Retorna status de todos os bots.
   */
  async getStatus() {
    const status = {};
    for (const [meeting, bot] of this.bots) {
      status[meeting] = await bot.getInfo();
    }
    return {
      totalBots: this.bots.size,
      maxBots: config.performance.maxConcurrentBots,
      bots: status,
    };
  }

  /**
   * Retorna info de um bot específico.
   */
  async getBotInfo(meetingNumber) {
    const bot = this.bots.get(String(meetingNumber));
    if (!bot) return null;
    return bot.getInfo();
  }

  /**
   * Health check: verifica se bots estão saudáveis e limpa os mortos.
   */
  async healthCheck() {
    for (const [meeting, bot] of this.bots) {
      try {
        // Verificar se a reunião terminou
        const ended = await bot.checkMeetingEnded();
        if (ended) {
          this.log.info(`Meeting ${meeting} terminou, removendo bot`);
          await this.removeBot(meeting);
          continue;
        }

        // Verificar se o bot está em estado de erro
        if (bot.status === 'error' || bot.status === 'stopped') {
          this.log.warn(`Bot para meeting ${meeting} em estado ${bot.status}, limpando`);
          await bot.destroy();
          this.bots.delete(meeting);
          continue;
        }

        // Verificar se o browser ainda está aberto
        if (bot.browser && !bot.browser.isConnected()) {
          this.log.warn(`Browser do bot ${meeting} desconectado, limpando`);
          this.bots.delete(meeting);
        }

      } catch (err) {
        this.log.error(`Health check falhou para meeting ${meeting}: ${err.message}`);
      }
    }
  }

  /**
   * Encerra todos os bots (shutdown graceful).
   */
  async shutdown() {
    this.log.info('Encerrando todos os bots...');

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    const promises = [];
    for (const [meeting] of this.bots) {
      promises.push(this.removeBot(meeting));
    }

    await Promise.allSettled(promises);
    this.log.info('Todos os bots encerrados');
  }
}

module.exports = BotManager;
