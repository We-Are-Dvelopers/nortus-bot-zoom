require('dotenv').config();

module.exports = {
  zoom: {
    sdkKey: process.env.ZOOM_SDK_KEY,
    sdkSecret: process.env.ZOOM_SDK_SECRET,
    s2sAccountId: process.env.ZOOM_S2S_ACCOUNT_ID,
    s2sClientId: process.env.ZOOM_S2S_CLIENT_ID,
    s2sClientSecret: process.env.ZOOM_S2S_CLIENT_SECRET,
  },
  api: {
    baseUrl: process.env.API_BASE_URL || 'http://localhost:9000',
    botSecret: process.env.BOT_SECRET,
  },
  bot: {
    name: process.env.BOT_NAME || 'Monitor Nortus',
    email: process.env.BOT_EMAIL || 'bot@nortus.com.br',
    port: parseInt(process.env.PORT || '3500', 10),
  },
  performance: {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
    maxConcurrentBots: parseInt(process.env.MAX_CONCURRENT_BOTS || '10', 10),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10),
    eventBufferSize: parseInt(process.env.EVENT_BUFFER_SIZE || '20', 10),
    eventBufferFlushMs: parseInt(process.env.EVENT_BUFFER_FLUSH_MS || '10000', 10),
  },
};
