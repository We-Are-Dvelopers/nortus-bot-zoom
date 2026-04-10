const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, component, botId, meeting, ...rest }) => {
      const prefix = [component, botId, meeting ? `m:${meeting}` : ''].filter(Boolean).join(' | ');
      const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${prefix ? `[${prefix}] ` : ''}${message}${extra}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/bot-error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/bot.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

module.exports = logger;
