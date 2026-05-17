import {
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  PlatformAccessory
} from 'homebridge';
import {
  setThermostatState,
  setThermostatTargetCoolTemperature,
  setThermostatTargetHeatTemperature,
  ThermostatState
} from 'node-alarm-dot-com';
import { THERMOSTAT_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { ThermostatContext } from '../_models/Contexts';
import { HandlerContext, MANUFACTURER } from './HandlerContext';

export class ThermostatHandler {
  constructor(private readonly ctx: HandlerContext) {}

  add(thermostat: ThermostatState): void {
    const { api, log, accessories, ignoredDevices, tempDisplayUnitSetting } = this.ctx;
    const hap = api.hap;
    const id = thermostat.id;
    let accessory = accessories.find((a) => a.context.accID === id) as PlatformAccessory<ThermostatContext> | undefined;
    if (accessory) {
      this.ctx.removeAccessory(accessory);
    }

    const model = 'Thermostat';
    const name = thermostat.attributes.description;
    const uuid = hap.uuid.generate(id);
    accessory = new api.platformAccessory(name, uuid);

    const shouldConvertToC = tempDisplayUnitSetting === hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    const currentTemperature = shouldConvertToC
      ? convertFtoC(thermostat.attributes.ambientTemp)
      : thermostat.attributes.ambientTemp;

    accessory.context = {
      accID: id,
      name: name,
      thermostatType: model,
      state: getThermostatState(thermostat.attributes.state, hap),
      desiredState: getThermostatState(thermostat.attributes.state, hap),
      currentTemperature: currentTemperature,
      targetTemperature: getThermostatTargetTemperature(thermostat, shouldConvertToC),
      supportsHumidity: thermostat.attributes.supportsHumidity,
      humidityLevel: thermostat.attributes.humidityLevel ?? 0
    };

    if (!ignoredDevices.includes(id)) {
      log.info(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (current temp: ${currentTemperature})`);
      this.ctx.addAccessory(accessory, hap.Service.Thermostat, model);
      this.setup(accessory);
      this.stat(accessory, thermostat);
    }
  }

  setup(accessory: PlatformAccessory<ThermostatContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.thermostatType;

    if (!hap.Characteristic.TargetTemperature && log.logLevel > 1) {
      throw new Error(`Unrecognized thermostat ${id}`);
    }

    const service = accessory.getService(hap.Service.Thermostat);
    if (service === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${id}`);
    }

    service
      .setCharacteristic(hap.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hap.Characteristic.Model, model)
      .setCharacteristic(hap.Characteristic.SerialNumber, id);

    accessory.on('identify', () => {
      log.info(`${name} identify requested`);
    });

    service
      .getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.state);
      });

    service
      .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeThermostatState(accessory, value, callback)
      );

    service
      .getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.currentTemperature);
      });

    service
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.targetTemperature))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeThermostatTargetTemperature(accessory, value as number, callback)
      );

    if (accessory.context.supportsHumidity) {
      service
        .getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
        .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.humidityLevel));
    }
  }

  stat(accessory: PlatformAccessory<ThermostatContext>, thermostat: ThermostatState): void {
    const { api, log, tempDisplayUnitSetting } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const shouldConvertToC = tempDisplayUnitSetting === hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    const currentTemperature = shouldConvertToC
      ? convertFtoC(thermostat.attributes.ambientTemp)
      : thermostat.attributes.ambientTemp;
    const targetTemperature = getThermostatTargetTemperature(thermostat, shouldConvertToC);
    const currentState = getThermostatState(thermostat.attributes.state, hap);
    const targetState = getThermostatState(thermostat.attributes.desiredState, hap);
    const humidityLevel = thermostat.attributes.humidityLevel;

    const thermostatService = accessory.getService(hap.Service.Thermostat);
    if (thermostatService === undefined) {
      log.error(`Thermostat service was undefined when attempting to stat thermostat state for device id ${id}`);
      return;
    }

    if (currentTemperature !== accessory.context.currentTemperature) {
      log.info(
        `Updating thermostat ${name} (${id}), ambientTemp=${currentTemperature}, prev=${accessory.context.currentTemperature}`
      );
      accessory.context.currentTemperature = currentTemperature;
      thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature).updateValue(currentTemperature);
    }

    if (targetTemperature && targetTemperature !== accessory.context.targetTemperature) {
      log.info(
        `Updating thermostat ${name} (${id}), targetTemp=${targetTemperature}, prev=${accessory.context.targetTemperature}`
      );
      accessory.context.targetTemperature = targetTemperature;
      thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature).updateValue(targetTemperature);
    }

    if (currentState !== accessory.context.state) {
      log.info(`Updating thermostat ${name} (${id}), state=${currentState}, prev=${accessory.context.state}`);
      accessory.context.state = currentState;
      thermostatService.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState).updateValue(currentState);
    }

    if (targetState !== accessory.context.desiredState) {
      log.info(
        `Updating thermostat ${name} (${id}), targetState=${targetState}, prev=${accessory.context.desiredState}`
      );
      accessory.context.desiredState = targetState;
      thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).updateValue(targetState);
    }

    if (
      accessory.context.supportsHumidity &&
      humidityLevel !== undefined &&
      humidityLevel !== accessory.context.humidityLevel
    ) {
      log.info(
        `Updating thermostat ${name} (${id}), humidity=${humidityLevel}, prev=${accessory.context.humidityLevel}`
      );
      accessory.context.humidityLevel = humidityLevel;
      thermostatService.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).updateValue(humidityLevel);
    }
  }

  async changeThermostatState(
    accessory: PlatformAccessory<ThermostatContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;

    log.info(`Thermostat ${id}, state change: ${value}`);
    accessory.context.desiredState = value;

    let newState: THERMOSTAT_STATES = THERMOSTAT_STATES.OFF;
    switch (value) {
      case hap.Characteristic.CurrentHeatingCoolingState.HEAT:
        newState = THERMOSTAT_STATES.HEATING;
        break;
      case hap.Characteristic.CurrentHeatingCoolingState.COOL:
        newState = THERMOSTAT_STATES.COOLING;
        break;
      case hap.Characteristic.CurrentHeatingCoolingState.OFF:
        newState = THERMOSTAT_STATES.OFF;
        break;
    }

    await this.ctx
      .loginSession()
      .then((res) => setThermostatState(id, newState, res))
      .then((res) => res.data)
      .then((thermostat) => {
        this.stat(accessory, thermostat);
      })
      .then(() => callback())
      .catch((err) => {
        log.error(`Error: Failed to change thermostat state: ${err.stack}`);
        this.ctx.refreshDevices();
        callback(err);
      });
  }

  async changeThermostatTargetTemperature(
    accessory: PlatformAccessory<ThermostatContext>,
    value: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const { api, log, tempDisplayUnitSetting } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    let method: typeof setThermostatTargetHeatTemperature | typeof setThermostatTargetCoolTemperature;

    switch (accessory.context.state) {
      case hap.Characteristic.CurrentHeatingCoolingState.HEAT:
        method = setThermostatTargetHeatTemperature;
        break;
      case hap.Characteristic.CurrentHeatingCoolingState.COOL:
        method = setThermostatTargetCoolTemperature;
        break;
      default: {
        const msg = `Can't set temperature when in unknown state ${accessory.context.state}`;
        log.error(msg);
        return callback(new Error(msg));
      }
    }

    log.info(`Thermostat ${id}, temp change: ${value}`);
    accessory.context.targetTemperature = value;

    if (tempDisplayUnitSetting === hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT) {
      value = convertCtoF(value);
    }

    await this.ctx
      .loginSession()
      .then((res) => method(id, value, res))
      .then((res) => res.data)
      .then((thermostat) => {
        this.stat(accessory, thermostat);
      })
      .then(() => callback())
      .catch((err) => {
        log.error(`Error: Failed to change thermostat state: ${err.stack}`);
        this.ctx.refreshDevices();
        callback(err);
      });
  }

  refresh(thermostat: ThermostatState): void {
    const { accessories, ignoredDevices } = this.ctx;
    const accessory = accessories.find((a) => a.context.accID === thermostat.id) as
      | PlatformAccessory<ThermostatContext>
      | undefined;
    if (!ignoredDevices.includes(thermostat.id)) {
      if (!accessory) {
        return this.add(thermostat);
      }
      this.stat(accessory, thermostat);
    }
  }
}

function getThermostatState(state: number, hap: HAP): CharacteristicValue {
  switch (state) {
    case THERMOSTAT_STATES.HEATING:
      return hap.Characteristic.CurrentHeatingCoolingState.HEAT;
    case THERMOSTAT_STATES.COOLING:
      return hap.Characteristic.CurrentHeatingCoolingState.COOL;
    case THERMOSTAT_STATES.OFF:
    default:
      return hap.Characteristic.CurrentHeatingCoolingState.OFF;
  }
}

function getThermostatTargetTemperature(thermostat: ThermostatState, convertToC: boolean): number {
  let value: number;

  switch (thermostat.attributes.desiredState) {
    case THERMOSTAT_STATES.HEATING:
      value = thermostat.attributes.desiredHeatSetpoint;
      break;
    case THERMOSTAT_STATES.COOLING:
      value = thermostat.attributes.desiredCoolSetpoint;
      break;
    case THERMOSTAT_STATES.AUTO:
    case THERMOSTAT_STATES.OFF:
    default:
      switch (thermostat.attributes.inferredState) {
        case THERMOSTAT_STATES.HEATING:
          value = thermostat.attributes.desiredHeatSetpoint;
          break;
        case THERMOSTAT_STATES.OFF:
        case THERMOSTAT_STATES.AUTO:
        case THERMOSTAT_STATES.COOLING:
          value = thermostat.attributes.desiredCoolSetpoint;
          break;
      }
  }

  if (convertToC) {
    value = convertFtoC(value);
  }

  return value;
}

function convertFtoC(f: number): number {
  return Math.round((5 / 9) * (f - 32));
}

function convertCtoF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}
