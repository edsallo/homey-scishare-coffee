'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const TOKEN = /^[a-f\d]{32}$/i;

function connection(values, translate = key => key) {
  const ip = String(values?.ip || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const token = String(values?.token || '').trim().toLowerCase();
  if (!IPV4.test(ip)) throw new Error(translate('validation.ipv4'));
  if (!TOKEN.test(token)) throw new Error(translate('validation.token'));
  return { ip, token };
}

async function checkConnection(values, translate = key => key) {
  const { ip, token } = connection(values, translate);
  const device = new MiioClient(ip, token);
  const info = await device.call('miIO.info', []);
  if (info?.model !== 'scishare.coffee.s1102') {
    throw new Error(translate('validation.wrong_model', {
      model: info?.model || translate('validation.unknown_model'),
    }));
  }
  const status = await device.call('Query_Machine_Status', []);
  return { ip, token, model: info.model, status: Array.isArray(status) ? status[1] : null };
}

class ScishareCoffeeDriver extends Homey.Driver {
  async onPair(session) {
    session.setHandler('verify_connection', values => checkConnection(values, this.homey.__.bind(this.homey)));
  }
}

module.exports = ScishareCoffeeDriver;
module.exports.checkConnection = checkConnection;
