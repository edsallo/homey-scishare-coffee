# Scishare Coffee for Homey

Local LAN control of the Scishare Smart Capsule Coffee Machine S1102 from Homey Pro. The app communicates with the coffee machine directly via the local MiIO UDP protocol; it does not require a Xiaomi cloud account after pairing.

## Features

- Power control and status refresh.
- Brew espresso, americano, or dispense hot water from Flow.
- Three quick buttons in the device card: **Espresso**, **Americano**, and **Hot water**.
- Per-drink volume and temperature settings in **Advanced Settings**.
- Automatic power-on and preheating before dispensing.
- Flow triggers for an empty water tank and for a confirmed completed operation.
- Local MiIO token and IP address are entered only during pairing or device settings and are never stored in this repository.

## Requirements

- Homey Pro with Developer Tools / Homey CLI access.
- Scishare Smart Capsule Coffee Machine S1102 reachable on the same LAN as Homey.
- A reserved local IPv4 address for the machine.
- The machine's 32-character MiIO token.

## Install locally

1. Install Node.js 18 or newer and the Homey CLI:

   ```bash
   npm install -g homey
   ```

2. Clone the repository and install the development dependency:

   ```bash
   git clone https://github.com/edsallo/homey-scishare-coffee.git
   cd homey-scishare-coffee
   npm install
   ```

3. Authenticate the Homey CLI, then validate and install the app:

   ```bash
   homey login
   homey app validate
   homey app install
   ```

4. In Homey, add **Scishare Coffee → Coffee machine Scishare S1102**. Enter the reserved IPv4 address and MiIO token.

Do not use `homey app install --clean`: it removes existing paired devices.

## Safety

The appliance dispenses hot water. Ensure a suitable cup is under the spout before starting a Flow or using a quick button. The app reports status from the machine, but a flow should not be treated as a substitute for supervision.

## License

[MIT](LICENSE)
