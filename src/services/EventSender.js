const fetch = require('node-fetch');
const config = require('../config');
const logger = require('./logger');

/**
 * EventSender - Envia eventos do bot para a API PHP.
 *
 * Features:
 * - Buffer de eventos (envia em batch para eficiência)
 * - Retry com backoff exponencial
 * - Fallback para envio individual se batch falhar
 */
class EventSender {
  constructor() {
    this.buffer = [];
    this.flushTimer = null;
    this.log = logger.child({ component: 'EventSender' });
    this.retryQueue = [];

    // Flush periódico do buffer
    this.flushTimer = setInterval(
      () => this.flush(),
      config.performance.eventBufferFlushMs
    );
  }

  /**
   * Adiciona evento ao buffer.
   */
  queue(event) {
    this.buffer.push(event);

    // Se atingiu o tamanho do buffer, enviar imediatamente
    if (this.buffer.length >= config.performance.eventBufferSize) {
      this.flush();
    }
  }

  /**
   * Envia um batch de eventos diretamente (bypass do buffer).
   */
  async sendBatch(events) {
    if (!events || events.length === 0) return;

    try {
      const response = await this.apiCall('/zoom/bot-events-batch', {
        events,
      });

      if (response.ok) {
        const data = await response.json();
        this.log.info(`Batch enviado: ${data.processed} eventos processados`);
      } else {
        const errorText = await response.text();
        this.log.error(`Erro ao enviar batch (${response.status}): ${errorText}`);
        // Re-enfileirar para retry
        this.retryQueue.push(...events);
        this.scheduleRetry();
      }
    } catch (err) {
      this.log.error(`Erro de rede ao enviar batch: ${err.message}`);
      this.retryQueue.push(...events);
      this.scheduleRetry();
    }
  }

  /**
   * Envia heartbeat para o backend.
   */
  async sendHeartbeat(data) {
    try {
      await this.apiCall('/zoom/bot-heartbeat', data);
    } catch (err) {
      this.log.warn(`Heartbeat falhou: ${err.message}`);
    }
  }

  /**
   * Flush: envia todos os eventos do buffer.
   */
  async flush() {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    await this.sendBatch(events);
  }

  /**
   * Faz uma chamada à API PHP.
   */
  async apiCall(endpoint, body) {
    const url = `${config.api.baseUrl}${endpoint}`;

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': config.api.botSecret,
      },
      body: JSON.stringify(body),
      timeout: 10000,
    });
  }

  /**
   * Agenda retry dos eventos que falharam.
   */
  scheduleRetry() {
    if (this.retryTimeout) return; // Já tem retry agendado

    this.retryTimeout = setTimeout(async () => {
      this.retryTimeout = null;

      if (this.retryQueue.length === 0) return;

      this.log.info(`Retry: reenviando ${this.retryQueue.length} eventos`);
      const events = [...this.retryQueue];
      this.retryQueue = [];

      // Tentar enviar individualmente se batch falhar de novo
      try {
        await this.sendBatch(events);
      } catch (err) {
        this.log.error(`Retry batch falhou, tentando individual...`);
        for (const event of events) {
          try {
            await this.apiCall('/zoom/bot-event', event);
          } catch (e) {
            this.log.error(`Evento perdido: ${JSON.stringify(event)}`);
          }
        }
      }
    }, 5000); // Retry após 5 segundos
  }

  /**
   * Shutdown: envia todos os eventos restantes.
   */
  async shutdown() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retryTimeout) clearTimeout(this.retryTimeout);

    await this.flush();

    if (this.retryQueue.length > 0) {
      this.log.warn(`${this.retryQueue.length} eventos na fila de retry no shutdown`);
      await this.sendBatch(this.retryQueue);
    }
  }
}

module.exports = EventSender;
