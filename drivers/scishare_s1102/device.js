'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');

const STATUS = {
  1: 'Выключена', 2: 'Включена', 3: 'Самопроверка', 4: 'Нагрев остановлен',
  5: 'Готова к приготовлению', 6: 'Удаление накипи остановлено', 7: 'Ожидание',
  8: 'Нагрев', 201: 'Приготовление', 203: 'Нет воды',
};
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 2000;
const ACTIVE_POLL_MS = 2000;
const ACTIVE_POLL_DURATION_MS = 120000;
const OPERATION_NAMES = {
  espresso: 'Эспрессо',
  americano: 'Амерек+ано',
  hot_water: 'Горячая вода',
};

const OPERATION_READY_MESSAGES = {
  espresso: 'Ваш эспрессо готов!',
  americano: 'Ваш амерек+ано готов!',
  hot_water: 'Ваша горячая вода уже в чашке!',
};

function number(value, min, max, title) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${title}: допустимо от ${min} до ${max}`);
  }
  return parsed;
}

class ScishareCoffeeDevice extends Homey.Device {
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
    await this.poll();
    this.startPolling();
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
        this.setWarning('Не удалось подтвердить завершение приготовления за 2 минуты').catch(error => this.error(error));
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
    if (!/^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip)) throw new Error('Не задан корректный IPv4-адрес кофемашины');
    if (!/^[a-f\d]{32}$/i.test(token)) throw new Error('Не задан корректный MiIO token');
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
      return { code, text: STATUS[code] || 'Неизвестное состояние' };
    } catch (error) {
      await this.setUnavailable(`Кофемашина недоступна: ${error.message}`);
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
    await this.setStoreValue('status_text', STATUS[code] || `Неизвестное состояние (${code})`);
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
    if (code === 201) {
      operation.seenPreparing = true;
      return;
    }
    if (code === 203) {
      this._activeOperation = null;
      this.stopActivePolling();
      return;
    }
    // Small water portions can be completed between two 2-second polls. The
    // command acknowledgement plus a later Ready state is then the reliable
    // completion signal even when status 201 was never observed.
    if (code === 5 && (operation.seenPreparing || Date.now() - operation.acceptedAt >= 1000)) {
      this._activeOperation = null;
      this.stopActivePolling();
      await this.homey.app.operationCompletedTrigger.trigger(this, {
        operation: operation.name,
        message: OPERATION_READY_MESSAGES[operation.type],
      });
    }
  }

  async _startBrewWorkflow(method, params, label, temperature, operation) {
    if (this._brewWorkflow) throw new Error('Уже ожидается готовность кофемашины к другому напитку');
    this._brewWorkflow = {
      method, params, label, temperature, operation,
      deadline: Date.now() + READY_TIMEOUT_MS, turnedOn: false, preheatRequested: false,
    };
    try {
      await this._advanceBrewWorkflow();
      return true;
    } catch (error) {
      this._clearBrewWorkflow();
      throw error;
    }
  }

  _clearBrewWorkflow() {
    clearTimeout(this._brewTimer);
    this._brewTimer = null;
    this._brewWorkflow = null;
  }

  async _advanceBrewWorkflow() {
    const workflow = this._brewWorkflow;
    if (!workflow) return;
    if (Date.now() >= workflow.deadline) throw new Error('Кофемашина не стала готова к приготовлению за 2 минуты');

    const code = await this._readStatus();
    if (code === 203) throw new Error('Приготовление не начато: в кофемашине нет воды');
    if (code === 201) throw new Error('Приготовление не начато: кофемашина уже готовит напиток');
    if (code === 5) {
      await this._run(workflow.method, workflow.params, workflow.label);
      this._activeOperation = {
        type: workflow.operation,
        name: OPERATION_NAMES[workflow.operation],
        seenPreparing: false,
        acceptedAt: Date.now(),
      };
      this.startActivePolling();
      this._clearBrewWorkflow();
      await this.unsetWarning();
      return;
    }

    if (code === 1 && !workflow.turnedOn) {
      await this._run('Machine_ON', [], 'Включение кофемашины');
      workflow.turnedOn = true;
    }

    if ([2, 4, 7].includes(code) && !workflow.preheatRequested) {
      await this._run('Boiler_Preheating_Set', [workflow.temperature], 'Нагрев кофемашины');
      workflow.preheatRequested = true;
    }

    this._brewTimer = this.homey.setTimeout(() => {
      this._advanceBrewWorkflow().catch(async error => {
        this._clearBrewWorkflow();
        await this.setWarning(`Приготовление отменено: ${error.message}`);
        this.error(error);
      });
    }, READY_POLL_MS);
  }

  async _run(method, params, label) {
    const reply = await this._call(method, params);
    if (!Array.isArray(reply) || reply[0] !== 'ok') throw new Error(`${label}: кофемашина не подтвердила команду`);
    this.homey.setTimeout(() => this.poll().catch(error => this.error(error)), 1200);
    return true;
  }

  async setPower(value) {
    return this._run(value ? 'Machine_ON' : 'Machine_OFF', [], value ? 'Включение' : 'Выключение');
  }

  async brewEspresso(amount, temperature) {
    const selectedTemperature = number(temperature, 40, 100, 'Температура');
    return this._startBrewWorkflow('Espresso_Coffee', [
      number(amount, 10, 200, 'Объём'), selectedTemperature,
    ], 'Приготовление эспрессо', selectedTemperature, 'espresso');
  }

  async brewAmericano(totalAmount, coffeeAmount, temperature) {
    const total = number(totalAmount, 20, 400, 'Общий объём');
    const coffee = number(coffeeAmount, 10, 200, 'Объём кофе');
    const water = total - coffee;
    if (water < 10) throw new Error('Общий объём должен быть минимум на 10 мл больше объёма кофе');
    const selectedTemperature = number(temperature, 40, 100, 'Температура');
    return this._startBrewWorkflow('Americano_Coffee', [
      water, selectedTemperature, coffee, selectedTemperature,
    ], 'Приготовление американо', selectedTemperature, 'americano');
  }

  async boilWater(amount, temperature) {
    const selectedTemperature = number(temperature, 40, 100, 'Температура');
    return this._startBrewWorkflow('Hot_Wate', [
      number(amount, 10, 400, 'Объём'), selectedTemperature,
    ], 'Подача горячей воды', selectedTemperature, 'hot_water');
  }

  async preheat(temperature) {
    return this._run('Boiler_Preheating_Set', [number(temperature, 40, 100, 'Температура')], 'Нагрев');
  }

  async stopPreheat() {
    return this._run('Stop_Boiler_Preheat', [], 'Остановка нагрева');
  }
}

module.exports = ScishareCoffeeDevice;
