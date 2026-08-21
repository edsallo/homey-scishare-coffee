'use strict';

const Homey = require('homey');

class ScishareCoffeeApp extends Homey.App {
  async onInit() {
    this.waterEmptyTrigger = this.homey.flow.getDeviceTriggerCard('water_empty');
    this.operationCompletedTrigger = this.homey.flow.getDeviceTriggerCard('operation_completed');
    const actions = {
      brew_espresso: ({ device, amount, temperature }) => device.brewEspresso(amount, temperature),
      brew_americano: ({ device, total_amount, coffee_amount, temperature }) => (
        device.brewAmericano(total_amount, coffee_amount, temperature)
      ),
      boil_water: ({ device, amount, temperature }) => device.boilWater(amount, temperature),
      preheat: ({ device, temperature }) => device.preheat(temperature),
      stop_preheat: ({ device }) => device.stopPreheat(),
      refresh_status: ({ device }) => device.poll(),
    };
    for (const [id, listener] of Object.entries(actions)) {
      this.homey.flow.getActionCard(id).registerRunListener(listener);
    }
  }
}

module.exports = ScishareCoffeeApp;
