const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Gera JWT signatures para o Zoom Meeting SDK.
 * Mesma lógica do backend PHP (ZoomController::signature).
 */
class SignatureGenerator {
  /**
   * Gera signature para entrar em uma reunião.
   * @param {string} meetingNumber - Número da reunião Zoom
   * @param {number} role - 0 = attendee, 1 = host
   * @returns {string} JWT signature
   */
  static generate(meetingNumber, role = 0) {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 7200; // 2 horas

    const payload = {
      sdkKey: config.zoom.sdkKey,
      mn: String(meetingNumber),
      role,
      iat,
      exp,
      appKey: config.zoom.sdkKey,
      tokenExp: exp,
    };

    return jwt.sign(payload, config.zoom.sdkSecret, { algorithm: 'HS256' });
  }
}

module.exports = SignatureGenerator;
