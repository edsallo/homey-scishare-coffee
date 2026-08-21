'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const TOKEN = /^[a-f\d]{32}$/i;

function connection(values) {
  const ip = String(values?.ip || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const token = String(values?.token || '').trim().toLowerCase();
  if (!IPV4.test(ip)) throw new Error('Введите корректный локальный IPv4-адрес, например 10.0.1.228');
  if (!TOKEN.test(token)) throw new Error('MiIO token должен содержать 32 шестнадцатеричных символа');
  return { ip, token };
}

async function checkConnection(values) {
  const { ip, token } = connection(values);
  const device = new MiioClient(ip, token);
  const info = await device.call('miIO.info', []);
  if (info?.model !== 'scishare.coffee.s1102') {
    throw new Error(`Это не Scishare S1102: ${info?.model || 'модель не определена'}`);
  }
  const status = await device.call('Query_Machine_Status', []);
  return { ip, token, model: info.model, status: Array.isArray(status) ? status[1] : null };
}

class ScishareCoffeeDriver extends Homey.Driver {
  async onPair(session) {
    session.setHandler('verify_connection', checkConnection);
  }
}

module.exports = ScishareCoffeeDriver;
module.exports.checkConnection = checkConnection;
