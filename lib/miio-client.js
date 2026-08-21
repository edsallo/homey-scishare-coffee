'use strict';

// Minimal MiIO UDP client. It deliberately uses only Node.js built-ins so the
// Homey debug installer always ships everything required by this application.
const crypto = require('crypto');
const dgram = require('dgram');

const PORT = 54321;
const TIMEOUT_MS = 4000;

class MiioClient {
  constructor(address, token) {
    this.address = address;
    this.token = Buffer.from(token, 'hex');
    this.key = crypto.createHash('md5').update(this.token).digest();
    this.iv = crypto.createHash('md5').update(this.key).update(this.token).digest();
    this.requestId = 0;
  }

  async call(method, params = []) {
    const socket = dgram.createSocket('udp4');
    try {
      const session = await this._handshake(socket);
      return await this._request(socket, session, method, params);
    } finally {
      socket.close();
    }
  }

  _send(socket, packet) {
    return new Promise((resolve, reject) => socket.send(packet, PORT, this.address, error => error ? reject(error) : resolve()));
  }

  _receive(socket, predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Тайм-аут ответа кофемашины')), TIMEOUT_MS);
      const onMessage = message => {
        try {
          const value = predicate(message);
          if (value !== undefined) finish(null, value);
        } catch (error) {
          finish(error);
        }
      };
      const onError = error => finish(error);
      const finish = (error, value) => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        socket.off('error', onError);
        error ? reject(error) : resolve(value);
      };
      socket.on('message', onMessage);
      socket.once('error', onError);
    });
  }

  async _handshake(socket) {
    const packet = Buffer.alloc(32, 0xff);
    packet[0] = 0x21;
    packet[1] = 0x31;
    packet.writeUInt16BE(32, 2);
    const response = this._receive(socket, message => {
      if (message.length !== 32 || message[0] !== 0x21 || message[1] !== 0x31) return undefined;
      return { deviceId: message.readUInt32BE(8), stamp: message.readUInt32BE(12), observedAt: Date.now() };
    });
    await this._send(socket, packet);
    return response;
  }

  async _request(socket, session, method, params) {
    const id = this.requestId = this.requestId >= 9999 ? 1 : this.requestId + 1;
    const plaintext = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const header = Buffer.alloc(32);
    header[0] = 0x21;
    header[1] = 0x31;
    header.writeUInt16BE(32 + encrypted.length, 2);
    header.writeUInt32BE(session.deviceId, 8);
    header.writeUInt32BE((session.stamp + Math.floor((Date.now() - session.observedAt) / 1000)) >>> 0, 12);
    crypto.createHash('md5').update(header.subarray(0, 16)).update(this.token).update(encrypted).digest().copy(header, 16);
    const response = this._receive(socket, message => this._decode(message, id));
    await this._send(socket, Buffer.concat([header, encrypted]));
    return response;
  }

  _decode(message, requestId) {
    if (message.length <= 32 || message[0] !== 0x21 || message[1] !== 0x31) return undefined;
    const header = message.subarray(0, 32);
    const encrypted = message.subarray(32);
    const checksum = crypto.createHash('md5').update(header.subarray(0, 16)).update(this.token).update(encrypted).digest();
    if (!checksum.equals(header.subarray(16, 32))) return undefined;
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
    const payload = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8').replace(/\0+$/, '');
    const reply = JSON.parse(payload);
    if (reply.id !== requestId) return undefined;
    if (Object.prototype.hasOwnProperty.call(reply, 'error')) {
      const error = new Error(reply.error?.message || 'Кофемашина отклонила команду');
      error.code = reply.error?.code;
      throw error;
    }
    return reply.result;
  }
}

module.exports = MiioClient;
