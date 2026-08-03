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
  ThermostatState,
  WebSocketEvent,
  WebSocketEventTypes
} from 'node-alarm-dot-com';
import { THERMOSTAT_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { ThermostatContext } from '../_models/Contexts';
import { BaseHandler } from './BaseHandler';
import { HandlerContext } from './HandlerContext';

export class ThermostatHandler extends BaseHandler<ThermostatContext, ThermostatState, WebSocketEvent> {
  constructor(ctx: HandlerContext) {
    super(ctx);
  }

  add(thermostat: ThermostatState): void {
    const { api, log, ignoredDevices, tempDisplayUnitSetting } = this.ctx;
    const hap = api.hap;
    const id = thermostat.id;
    const model = 'Thermostat';
    const name = thermostat.attributes.description;
    const accessory = this.createAccessory(id, name);

    const shouldConvertToC = tempDisplayUnitSetting === hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    const currentTemperature = shouldConvertToC
      ? convertFtoC(thermostat.attributes.ambientTemp)
      : thermostat.attributes.ambientTemp;

    accessory.context = {
      accID: id,
      name: name,
      thermostatType: model,
      state: getThermostatCurrentState(thermostat.attributes.state, hap, thermostat.attributes.inferredState),
      desiredState: getThermostatTargetState(thermostat.attributes.desiredState, hap),
      currentTemperature: currentTemperature,
      targetTemperature: getThermostatTargetTemperature(thermostat, shouldConvertToC),
      supportsHumidity: thermostat.attributes.supportsHumidity,
      humidityLevel: thermostat.attributes.humidityLevel ?? 0
    };

    if (!ignoredDevices.includes(id)) {
      log.info(`Adding ${model} "${name}" (id=${id}, uuid=${accessory.UUID}) (current temp: ${currentTemperature})`);
      this.ctx.addAccessory(accessory, hap.Service.Thermostat, model);
      this.setup(accessory);
      this.stat(accessory, thermostat);
    }
  }

  setup(accessory: PlatformAccessory<ThermostatContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const model = accessory.context.thermostatType;

    if (!hap.Characteristic.TargetTemperature && log.logLevel > 1) {
      log.error(`Unrecognized thermostat ${id}`);
      return;
    }

    this.setAccessoryInfo(accessory, model);
    this.registerIdentify(accessory);

    const service = accessory.getService(hap.Service.Thermostat);
    if (service === undefined) {
      log.error(`Trouble getting HomeKit accessory information for ${id}`);
      return;
    }

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
    const currentState = getThermostatCurrentState(
      thermostat.attributes.state,
      hap,
      thermostat.attributes.inferredState
    );
    const targetState = getThermostatTargetState(thermostat.attributes.desiredState, hap);
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

    let newState: THERMOSTAT_STATES;
    switch (value) {
      case hap.Characteristic.TargetHeatingCoolingState.HEAT:
        newState = THERMOSTAT_STATES.HEATING;
        break;
      case hap.Characteristic.TargetHeatingCoolingState.COOL:
        newState = THERMOSTAT_STATES.COOLING;
        break;
      case hap.Characteristic.TargetHeatingCoolingState.AUTO:
        newState = THERMOSTAT_STATES.AUTO;
        break;
      case hap.Characteristic.TargetHeatingCoolingState.OFF:
        newState = THERMOSTAT_STATES.OFF;
        break;
      default: {
        const msg = `Unsupported thermostat target state ${value}`;
        log.error(msg);
        callback(new Error(msg));
        return;
      }
    }

    accessory.context.desiredState = value;

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

    // Use desired (target) mode — current activity is HEAT/COOL/OFF only and has no AUTO.
    switch (accessory.context.desiredState) {
      case hap.Characteristic.TargetHeatingCoolingState.HEAT:
        method = setThermostatTargetHeatTemperature;
        break;
      case hap.Characteristic.TargetHeatingCoolingState.COOL:
        method = setThermostatTargetCoolTemperature;
        break;
      case hap.Characteristic.TargetHeatingCoolingState.AUTO:
        // Single TargetTemperature is ambiguous in AUTO; pick the active side.
        switch (accessory.context.state) {
          case hap.Characteristic.CurrentHeatingCoolingState.HEAT:
            method = setThermostatTargetHeatTemperature;
            break;
          case hap.Characteristic.CurrentHeatingCoolingState.COOL:
            method = setThermostatTargetCoolTemperature;
            break;
          default: {
            const msg = `Can't set a single target temperature while in AUTO with no active heat/cool`;
            log.error(msg);
            return callback(new Error(msg));
          }
        }
        break;
      default: {
        const msg = `Can't set temperature when in target state ${accessory.context.desiredState}`;
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

  statFromWebSocket(accessory: PlatformAccessory<ThermostatContext>, event: WebSocketEvent): boolean {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const shouldConvertToC = this.ctx.tempDisplayUnitSetting === hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;

    const service = accessory.getService(hap.Service.Thermostat);
    if (!service) return false;

    switch (event.EventType as WebSocketEventTypes) {
      case WebSocketEventTypes.ThermostatModeChanged: {
        // WS EventValues (0=OFF, 1=HEAT, 2=COOL, 3=AUTO) map to HomeKit TargetHeatingCoolingState.
        // CurrentHeatingCoolingState has no AUTO — only update current for non-AUTO modes.
        const targetState = event.EventValue;
        if (targetState !== accessory.context.desiredState) {
          log.info(
            `Updating thermostat ${name} (${id}), targetState=${targetState}, prev=${accessory.context.desiredState}`
          );
          accessory.context.desiredState = targetState;
          service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).updateValue(targetState);
        }
        if (
          targetState !== hap.Characteristic.TargetHeatingCoolingState.AUTO &&
          targetState !== accessory.context.state
        ) {
          log.info(`Updating thermostat ${name} (${id}), state=${targetState}, prev=${accessory.context.state}`);
          accessory.context.state = targetState;
          service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState).updateValue(targetState);
        }
        return true;
      }
      case WebSocketEventTypes.ThermostatSetPointChanged: {
        const temp = shouldConvertToC ? convertFtoC(event.EventValue) : event.EventValue;
        if (temp !== accessory.context.targetTemperature) {
          log.info(
            `Updating thermostat ${name} (${id}), targetTemp=${temp}, prev=${accessory.context.targetTemperature}`
          );
          accessory.context.targetTemperature = temp;
          service.getCharacteristic(hap.Characteristic.TargetTemperature).updateValue(temp);
        }
        return true;
      }
      default:
        return false;
    }
  }
}

/** Map Alarm.com state to HomeKit CurrentHeatingCoolingState (no AUTO). */
function getThermostatCurrentState(state: number, hap: HAP, inferredState?: number): CharacteristicValue {
  const effective =
    state === THERMOSTAT_STATES.AUTO && inferredState !== undefined && inferredState !== THERMOSTAT_STATES.AUTO
      ? inferredState
      : state;

  switch (effective) {
    case THERMOSTAT_STATES.HEATING:
      return hap.Characteristic.CurrentHeatingCoolingState.HEAT;
    case THERMOSTAT_STATES.COOLING:
      return hap.Characteristic.CurrentHeatingCoolingState.COOL;
    case THERMOSTAT_STATES.OFF:
    case THERMOSTAT_STATES.AUTO:
    default:
      return hap.Characteristic.CurrentHeatingCoolingState.OFF;
  }
}

/** Map Alarm.com desired state to HomeKit TargetHeatingCoolingState (includes AUTO). */
function getThermostatTargetState(state: number, hap: HAP): CharacteristicValue {
  switch (state) {
    case THERMOSTAT_STATES.HEATING:
      return hap.Characteristic.TargetHeatingCoolingState.HEAT;
    case THERMOSTAT_STATES.COOLING:
      return hap.Characteristic.TargetHeatingCoolingState.COOL;
    case THERMOSTAT_STATES.AUTO:
      return hap.Characteristic.TargetHeatingCoolingState.AUTO;
    case THERMOSTAT_STATES.OFF:
    default:
      return hap.Characteristic.TargetHeatingCoolingState.OFF;
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
  return Math.round((((f - 32) * 5) / 9) * 2) / 2;
}

function convertCtoF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}
