'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const MiioClient = require('../lib/miio-client');

const timeout = sent => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', requestSent: sent });

function fixture() {
  let now = 0;
  const timers = [];
  const events = [];
  const calls = [];
  const context = {
    module: { exports: {} }, require: id => id === 'homey' ? { Device: class {} } : MiioClient,
    Date: class extends Date { static now() { return now; } }, clearInterval() {}, clearTimeout(timer) { if (timer) timer.cancelled = true; },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../drivers/scishare_s1102/device'), 'utf8'), context);
  const d = new context.module.exports();
  d.homey = {
    __: key => key,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    setInterval: () => ({}),
    app: { operationCompletedTrigger: { trigger: async (_, tokens) => events.push(tokens) } },
  };
  d.log = d.error = () => {};
  d.getSetting = () => undefined;
  d.setWarning = async value => { d.warning = value; };
  d.unsetWarning = async () => { d.warning = null; };
  d._readStatus = async () => 5;
  d._run = async method => { calls.push(method); };
  return { d, timers, events, calls, advance: ms => { now += ms; } };
}

test('water-empty trigger includes message and fires only once until water fault clears', async () => {
  const f = fixture();
  const waterEvents = [];
  f.d.homey.app.waterEmptyTrigger = { trigger: async (_, tokens) => waterEvents.push(tokens) };
  f.d.setCapabilityValue = f.d.setStoreValue = async () => {};
  let code = 203;
  f.d._call = async () => ['ok', code];
  const read = Object.getPrototypeOf(f.d)._readStatus.bind(f.d);
  await read();
  await read();
  assert.equal(waterEvents.length, 1);
  assert.equal(waterEvents[0].message, 'notification.no_water');
  code = 5;
  await read();
  code = 203;
  await read();
  assert.equal(waterEvents.length, 2);
});

test('descaling sends once, requires 6 then 5, emits only cleaning completion', async () => {
  const f = fixture();
  let cleaned = 0;
  f.d.homey.app.descalingCompletedTrigger = { trigger: async (_, tokens) => {
    cleaned++;
    assert.equal(tokens.message, 'ready_message.descaling');
  } };
  await f.d.startDescaling();
  f.advance(5000);
  await f.d._observeActiveOperation(4);
  await f.d._observeActiveOperation(5);
  assert.equal(cleaned, 0);
  await f.d._observeActiveOperation(6);
  await f.d._observeActiveOperation(5);
  await f.d._observeActiveOperation(5);
  assert.equal(cleaned, 1);
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.calls, ['Machine_Descaling']);
  assert.ok(f.timers.some(t => t.ms === 900000));
});

test('descaling lost reply is observed without resending; no water cancels', async () => {
  const f = fixture();
  f.d._run = async method => { f.calls.push(method); throw timeout(true); };
  await f.d.startDescaling();
  await f.d._observeActiveOperation(6);
  await f.d._observeActiveOperation(203);
  assert.equal(f.d._activeOperation, null);
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.calls, ['Machine_Descaling']);
});

test('descaling wakes sleeping machine and blocks drinks during cleaning', async () => {
  const f = fixture();
  const states = [1, 2];
  f.d._readStatus = async () => states.shift();
  await f.d.startDescaling();
  assert.deepEqual(f.calls, ['Machine_ON', 'Machine_Descaling']);
  await assert.rejects(f.d.brewEspresso(40, 90), /workflow_busy/);
});

test('lost acknowledgement: sends once and emits ready once after 51 → 5', async () => {
  const f = fixture();
  f.d._run = async method => { f.calls.push(method); throw timeout(true); };
  await f.d.brewEspresso(70, 100);
  assert.equal(f.d._activeOperation.confirmed, false);
  f.advance(140000);
  await f.d._observeActiveOperation(51);
  await f.d._observeActiveOperation(5);
  await f.d._observeActiveOperation(5);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].message, 'ready_message.espresso');
  assert.deepEqual(f.calls, ['Espresso_Coffee']);
});

test('lost acknowledgement plus idle alone never declares a drink ready', async () => {
  const f = fixture();
  f.d._run = async () => { throw timeout(true); };
  await f.d.brewEspresso(70, 100);
  f.advance(5000);
  await f.d._observeActiveOperation(5);
  assert.equal(f.events.length, 0);
  assert.ok(f.d._activeOperation);
});

test('cold boot Off reply after dispatch does not discard an accepted drink', async () => {
  const f = fixture();
  f.d._run = async method => { f.calls.push(method); throw timeout(true); };
  await f.d.brewEspresso(70, 100);
  await f.d._observeActiveOperation(1);
  assert.ok(f.d._activeOperation);
  await f.d._observeActiveOperation(4);
  f.advance(150000);
  await f.d._observeActiveOperation(51);
  await f.d._observeActiveOperation(5);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.calls, ['Espresso_Coffee']);
});

test('failed handshake is not treated as an accepted drink command', async () => {
  const f = fixture();
  f.d._run = async method => { f.calls.push(method); throw timeout(false); };
  await assert.rejects(f.d.brewEspresso(70, 100), /timeout/);
  assert.equal(f.d._activeOperation, null);
  assert.equal(f.d._brewWorkflow, null);
  assert.equal(f.calls.length, 1);
});

test('explicit machine rejection is not swallowed or retried', async () => {
  const f = fixture();
  f.d._run = async () => { throw Object.assign(new Error('rejected'), { code: -1, requestSent: true }); };
  await assert.rejects(f.d.brewEspresso(70, 100), /rejected/);
  assert.equal(f.d._activeOperation, null);
});

test('no water or turning off cancels observation without ready notification', async () => {
  for (const code of [203, 1]) {
    const f = fixture(); await f.d.brewEspresso(70, 100);
    await f.d._observeActiveOperation(51);
    await f.d._observeActiveOperation(code);
    await f.d._observeActiveOperation(5);
    assert.equal(f.events.length, 0);
    assert.equal(f.d._activeOperation, null);
  }
});

test('normal acknowledgement still supports a short preparation missed by polling', async () => {
  const f = fixture(); await f.d.boilWater(30, 80);
  f.advance(2000); await f.d._observeActiveOperation(5);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].message, 'ready_message.hot_water');
});

test('another drink is blocked while an uncertain command is being observed', async () => {
  const f = fixture();
  f.d._run = async method => { f.calls.push(method); throw timeout(true); };
  await f.d.brewEspresso(70, 100);
  await assert.rejects(f.d.brewEspresso(70, 100), /workflow_busy/);
  assert.equal(f.calls.length, 1);
});

test('status timeout after power-on retries only status then sends the drink once', async () => {
  const f = fixture(); let read = 0;
  f.d._readStatus = async () => {
    read++;
    if (read === 1) return 1;
    if (read === 2) throw timeout(false);
    return 4;
  };
  await f.d.brewEspresso(70, 100);
  assert.deepEqual(f.calls, ['Machine_ON']);
  await f.d._advanceBrewWorkflow();
  await f.d._advanceBrewWorkflow();
  assert.deepEqual(f.calls, ['Machine_ON', 'Espresso_Coffee']);
});

test('lost power-on reply is followed by reads, not repeated power or drink commands', async () => {
  const f = fixture(); let read = 0;
  f.d._readStatus = async () => ++read === 1 ? 1 : 4;
  f.d._run = async method => { f.calls.push(method); if (method === 'Machine_ON') throw timeout(true); };
  await f.d.brewEspresso(70, 100);
  await f.d._advanceBrewWorkflow();
  assert.deepEqual(f.calls, ['Machine_ON', 'Espresso_Coffee']);
});

test('observation now lasts five minutes and times out without notification or retry', async () => {
  const f = fixture(); await f.d.brewEspresso(70, 100);
  const stop = f.timers.find(timer => timer.ms === 300000);
  assert.ok(stop); await stop.fn();
  assert.equal(f.d._activeOperation, null);
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.calls, ['Espresso_Coffee']);
});

test('MiIO request annotates a lost response only after successful UDP send', async () => {
  const client = new MiioClient('127.0.0.1', '0'.repeat(32));
  client._send = async () => {};
  client._receive = () => Promise.reject(timeout(false));
  await assert.rejects(client._request({}, { deviceId: 1, stamp: 1, observedAt: Date.now() }, 'Espresso_Coffee', [70, 100]), error => error.requestSent === true && error.code === 'ETIMEDOUT');
  client._send = async () => { throw new Error('send failed'); };
  await assert.rejects(client._request({}, { deviceId: 1, stamp: 1, observedAt: Date.now() }, 'Espresso_Coffee', [70, 100]), error => error.requestSent === false);
});

test('custom ready phrases are selected per drink, trimmed and passed to Flow', async () => {
  const f = fixture();
  const settings = { ready_message_espresso: '  Эспрессо в чашке!  ', ready_message_americano: 'Американо готово', ready_message_hot_water: 'Вода готова' };
  f.d.getSetting = key => settings[key];
  assert.equal(f.d._readyMessage('americano'), 'Американо готово');
  assert.equal(f.d._readyMessage('hot_water'), 'Вода готова');
  await f.d.brewEspresso(70, 100);
  await f.d._observeActiveOperation(51);
  await f.d._observeActiveOperation(5);
  assert.equal(f.events[0].message, 'Эспрессо в чашке!');
});

test('missing, empty and whitespace phrases retain localized defaults', () => {
  const f = fixture();
  for (const custom of [undefined, null, '', '   ']) {
    f.d.getSetting = () => custom;
    for (const type of ['espresso', 'americano', 'hot_water']) assert.equal(f.d._readyMessage(type), 'ready_message.' + type);
  }
});
