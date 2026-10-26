'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');

const STATUS_KEYS = {
  1: 'status.off', 2: 'status.on', 3: 'status.self_check', 4: 'status.preheat_stopped',
  5: 'status.ready', 6: 'status.descale_stopped', 7: 'status.waiting',
  8: 'status.heating', 51: 'status.preparing', 201: 'status.brewing', 203: 'status.no_water',
};
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 2000;
const ACTIVE_POLL_MS = 2000;
const ACTIVE_POLL_DURATION_MS = 300000;
const BREWING_CODES = new Set([51, 201]);
const TRANSIENT_ERRORS = new Set(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED']);
const OPERATION_NAME_KEYS = {
  espresso: 'operation.espresso_name',
  americano: 'operation.americano_name',
  hot_water: 'operation.hot_water_name',
};

const OPERATION_READY_MESSAGE_KEYS = {
  espresso: 'ready_message.espresso',
  americano: 'ready_message.americano',
  hot_water: 'ready_message.hot_water',
};

function number(value, min, max, title, translate) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(translate('validation.range', { title: translate(title), min, max }));
  }
  return parsed;
}

class ScishareCoffeeDevice extends Homey.Device {
  _trace(event, details = {}) {
    const entry = { time: new Date().toISOString(), event, ...details };
    this.log('Completion tracking', JSON.stringify(entry));
    if (!this.homey.settings || !this.getData) return;
    const key = 'completion_diagnostics_' + this.getData().id;
    try {
      const rows = this.homey.settings.get(key) || [];
      this.homey.settings.set(key, [...rows.slice(-79), entry]);
    } catch (error) { this.error('Could not save completion diagnostics', error); }
  }

  _t(key, tokens) {
    return this.homey.__(key, tokens);
  }

  _statusText(code) {
    return this._t(STATUS_KEYS[code] || 'status.unknown', { code });
  }

  _operationName(type) {
    return this._t(OPERATION_NAME_KEYS[type]);
  }

  _readyMessage(type) {
    const custom = this.getSetting('ready_message_' + type);
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    return this._t(OPERATION_READY_MESSAGE_KEYS[type]);
  }

  async onInit() {
    this._requestChain = Promise.resolve();
    this._polling = false;
    this._brewWorkflow = null;
    this._activeOperation = null;
    this._waterEmptyReported = Boolean(this.getStoreValue('water_empty_reported'));
    if (this.getStoreValue('water_trigger_version') !== 2) {
      this._waterEmptyReported = false;
      await this.setStoreValue('water_empty_reported', false);
      await this.setStoreValue('water_trigger_version', 2);
    }
    await this._ensureQuickDrinkButtons();
    this.registerCapabilityListener('onoff', async value => this.setPower(value));
    this.registerCapabilityListener('button.espresso', async () => this.brewEspresso(
      this.getSetting('espresso_amount'), this.getSetting('espresso_temperature'),
    ));
    this.registerCapabilityListener('button.americano', async () => this.brewAmericano(
      this.getSetting('americano_total_amount'),
      this.getSetting('americano_coffee_amount'),
      this.getSetting('americano_temperature'),
    ));
    this.registerCapabilityListener('button.hot_water', async () => this.boilWater(
      this.getSetting('hot_water_amount'), this.getSetting('hot_water_temperature'),
    ));
    this.startPolling();
    // A missed first UDP reply must not prevent all future status polling.
    await this.poll().catch(error => this.error(error));
  }

  async _ensureQuickDrinkButtons() {
    for (const capability of ['button.espresso', 'button.americano', 'button.hot_water']) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }
  }

  startPolling() {
    clearInterval(this.pollTimer);
    const seconds = Math.max(10, Math.min(300, Number(this.getSetting('poll_interval')) || 20));
    this.pollTimer = this.homey.setInterval(() => this.poll(), seconds * 1000);
  }

  startActivePolling() {
    clearInterval(this.activePollTimer);
    clearTimeout(this.activePollStopTimer);
    this.activePollTimer = this.homey.setInterval(() => this.poll().catch(error => this.error(error)), ACTIVE_POLL_MS);
    this.activePollStopTimer = this.homey.setTimeout(() => {
      clearInterval(this.activePollTimer);
      this.activePollTimer = null;
      if (this._activeOperation) {
        this._trace('tracking_timeout', { type: this._activeOperation.type });
        this.setWarning(this._t('error.completion_unconfirmed')).catch(error => this.error(error));
        this._activeOperation = null;
      }
    }, ACTIVE_POLL_DURATION_MS);
  }

  stopActivePolling() {
    clearInterval(this.activePollTimer);
    clearTimeout(this.activePollStopTimer);
    this.activePollTimer = null;
    this.activePollStopTimer = null;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some(key => ['ip', 'token'].includes(key))) {
      await this._callWith(newSettings, 'miIO.info', []);
    }
    if (changedKeys.includes('poll_interval')) this.startPolling();
    if (changedKeys.some(key => ['ip', 'token', 'poll_interval'].includes(key))) await this.poll();
  }

  async onDeleted() {
    clearInterval(this.pollTimer);
    this.stopActivePolling();
    clearTimeout(this._brewTimer);
  }

  _settings(overrides = {}) {
    const ip = String(overrides.ip ?? this.getSetting('ip') ?? '').trim();
    const token = String(overrides.token ?? this.getSetting('token') ?? '').trim().toLowerCase();
    if (!/^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip)) throw new Error(this._t('validation.missing_ip'));
    if (!/^[a-f\d]{32}$/i.test(token)) throw new Error(this._t('validation.missing_token'));
    return { ip, token };
  }

  _queued(task) {
    const run = this._requestChain.then(task, task);
    this._requestChain = run.catch(() => undefined);
    return run;
  }

  _call(method, params = []) {
    return this._callWith({}, method, params);
  }

  _callWith(settings, method, params = []) {
    return this._queued(async () => {
      const { ip, token } = this._settings(settings);
      return new MiioClient(ip, token).call(method, params);
    });
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const code = await this._readStatus();
      await this.setAvailable();
      return { code, text: this._statusText(code) };
    } catch (error) {
      await this.setUnavailable(this._t('error.unavailable', { message: error.message }));
      throw error;
    } finally {
      this._polling = false;
    }
  }

  async _readStatus() {
    const reply = await this._call('Query_Machine_Status', []);
    const code = Number(Array.isArray(reply) ? reply[1] : NaN);
    await this.setCapabilityValue('onoff', code !== 1 && Number.isFinite(code));
    await this.setCapabilityValue('alarm_generic', code === 203);
    await this.setStoreValue('status_code', code);
    await this.setStoreValue('status_text', this._statusText(code));
    if (code === 203 && !this._waterEmptyReported) {
      await this.homey.app.waterEmptyTrigger.trigger(this);
      this._waterEmptyReported = true;
      await this.setStoreValue('water_empty_reported', true);
    } else if (code !== 203 && this._waterEmptyReported) {
      this._waterEmptyReported = false;
      await this.setStoreValue('water_empty_reported', false);
    }
    await this._observeActiveOperation(code);
    return code;
  }

  async _observeActiveOperation(code) {
    const operation = this._activeOperation;
    if (!operation) return;
    if (operation.lastCode !== code) {
      this._trace('status', { code, type: operation.type, confirmed: operation.confirmed });
      operation.lastCode = code;
    }
    if (BREWING_CODES.has(code)) {
      operation.seenPreparing = true;
      return;
    }
    if (code === 203) {
      this._activeOperation = null;
      this.stopActivePolling();
      return;
    }
    if (operation.awaitingReply) return;
    // During cold boot the firmware can still answer Off after accepting
    // a queued drink. Only treat Off as cancellation after preparation began.
    if (code === 1 && operation.seenPreparing) {
      this._trace('cancelled_off', { type: operation.type });
      this._activeOperation = null;
      this.stopActivePolling();
      return;
    }
    // Small water portions can be completed between two 2-second polls. The
    // command acknowledgement plus a later Ready state is then the reliable
    // completion signal even when status 201 was never observed.
    if (code === 5 && (operation.seenPreparing || (operation.confirmed && Date.now() - operation.acceptedAt >= 1000))) {
      this._activeOperation = null;
      this.stopActivePolling();
      await this.homey.app.operationCompletedTrigger.trigger(this, {
        operation: operation.name,
        message: this._readyMessage(operation.type),
      });
      this._trace('ready_sent', { type: operation.type });
      await this.unsetWarning();
    }
  }

  async _startBrewWorkflow(method, params, label, operation) {
    if (this._brewWorkflow || this._activeOperation) throw new Error(this._t('error.workflow_busy'));
    this._trace('requested', { type: operation });
    this._brewWorkflow = {
      method, params, label, operation,
      deadline: Date.now() + READY_TIMEOUT_MS, turnedOn: false,
    };
    try {
      await this._advanceBrewWorkflow();
      return true;
    } catch (error) {
      this._trace('startup_failed', { code: error.code, message: error.message });
      this._clearBrewWorkflow();
      throw error;
    }
  }

  _clearBrewWorkflow() {
    clearTimeout(this._brewTimer);
    this._brewTimer = null;
    this._brewWorkflow = null;
  }

  async _dispatchDrink(workflow) {
    const operation = {
      type: workflow.operation,
      name: this._operationName(workflow.operation),
      seenPreparing: false,
      confirmed: false,
      awaitingReply: true,
      acceptedAt: Date.now(),
    };
    this._activeOperation = operation;
    this._trace('dispatch', { type: operation.type });
    // Clear the startup workflow BEFORE sending. No timer or subsequent
    // status read is allowed to send this drink command again.
    this._clearBrewWorkflow();
    try {
      await this._run(workflow.method, workflow.params, workflow.label);
      operation.confirmed = true;
      this._trace('acknowledged', { type: operation.type });
      await this.unsetWarning();
    } catch (error) {
      if (error.code !== 'ETIMEDOUT' || !error.requestSent) {
        this._trace('dispatch_failed', { type: operation.type, code: error.code, requestSent: error.requestSent });
        if (this._activeOperation === operation) this._activeOperation = null;
        throw error;
      }
      this.log('Drink reply lost; observing status without resending', workflow.operation);
      this._trace('reply_lost', { type: operation.type });
      await this.setWarning(this._t('error.confirmation_lost'));
    } finally {
      operation.awaitingReply = false;
    }
    if (this._activeOperation === operation) this.startActivePolling();
  }

  _scheduleBrewWorkflow() {
    this._brewTimer = this.homey.setTimeout(() => {
      this._advanceBrewWorkflow().catch(async error => {
        this._trace('startup_failed', { code: error.code, message: error.message });
        this._clearBrewWorkflow();
        await this.setWarning(this._t('error.workflow_cancelled', { message: error.message }));
        this.error(error);
      });
    }, READY_POLL_MS);
  }

  async _advanceBrewWorkflow() {
    const workflow = this._brewWorkflow;
    if (!workflow) return;
    if (Date.now() >= workflow.deadline) throw new Error(this._t('error.workflow_timeout'));

    let code;
    try {
      code = await this._readStatus();
    } catch (error) {
      if (!TRANSIENT_ERRORS.has(error.code)) throw error;
      this._scheduleBrewWorkflow();
      return;
    }
    if (code === 203) throw new Error(this._t('error.no_water'));
    if (BREWING_CODES.has(code)) throw new Error(this._t('error.already_brewing'));
    if (code === 5) {
      return this._dispatchDrink(workflow);
    }

    if (code === 1 && !workflow.turnedOn) {
      workflow.turnedOn = true;
      try {
        await this._run('Machine_ON', [], this._t('operation.power_on'));
      } catch (error) {
        if (!TRANSIENT_ERRORS.has(error.code)) throw error;
        this._scheduleBrewWorkflow();
        return;
      }
      // Do not wait for the regular two-second workflow poll here. Send the
      // requested operation at the first post-boot idle state; S1102 may
      // still queue it behind its firmware-controlled initial warm-up.
      let postPowerOnCode;
      try {
        postPowerOnCode = await this._readStatus();
      } catch (error) {
        if (!TRANSIENT_ERRORS.has(error.code)) throw error;
        this._scheduleBrewWorkflow();
        return;
      }
      if ([2, 4, 5, 7].includes(postPowerOnCode)) {
        return this._dispatchDrink(workflow);
      }
    }

    // The drink/water command includes its target temperature. A separate
    // Boiler_Preheating_Set command is deliberately not sent beforehand.
    if ([2, 4, 7].includes(code)) {
      return this._dispatchDrink(workflow);
    }

    this._scheduleBrewWorkflow();
  }

  async _run(method, params, label) {
    const reply = await this._call(method, params);
    if (!Array.isArray(reply) || reply[0] !== 'ok') throw new Error(this._t('error.command_unconfirmed', { label }));
    this.homey.setTimeout(() => this.poll().catch(error => this.error(error)), 1200);
    return true;
  }

  async setPower(value) {
    return this._run(value ? 'Machine_ON' : 'Machine_OFF', [], this._t(value ? 'operation.power_on' : 'operation.power_off'));
  }

  async brewEspresso(amount, temperature) {
    const selectedTemperature = number(temperature, 40, 100, 'field.temperature', this._t.bind(this));
    return this._startBrewWorkflow('Espresso_Coffee', [
      number(amount, 10, 200, 'field.amount', this._t.bind(this)), selectedTemperature,
    ], this._t('operation.espresso'), 'espresso');
  }

  async brewAmericano(totalAmount, coffeeAmount, temperature) {
    const total = number(totalAmount, 20, 400, 'field.total_amount', this._t.bind(this));
    const coffee = number(coffeeAmount, 10, 200, 'field.coffee_amount', this._t.bind(this));
    const water = total - coffee;
    if (water < 10) throw new Error(this._t('error.americano_volume'));
    const selectedTemperature = number(temperature, 40, 100, 'field.temperature', this._t.bind(this));
    return this._startBrewWorkflow('Americano_Coffee', [
      water, selectedTemperature, coffee, selectedTemperature,
    ], this._t('operation.americano'), 'americano');
  }

  async boilWater(amount, temperature) {
    const selectedTemperature = number(temperature, 40, 100, 'field.temperature', this._t.bind(this));
    return this._startBrewWorkflow('Hot_Wate', [
      number(amount, 10, 400, 'field.amount', this._t.bind(this)), selectedTemperature,
    ], this._t('operation.hot_water'), 'hot_water');
  }

  async preheat(temperature) {
    return this._run('Boiler_Preheating_Set', [number(temperature, 40, 100, 'field.temperature', this._t.bind(this))], this._t('operation.preheat'));
  }

  async stopPreheat() {
    return this._run('Stop_Boiler_Preheat', [], this._t('operation.stop_preheat'));
  }
}

module.exports = ScishareCoffeeDevice;
