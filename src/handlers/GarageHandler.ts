import {
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  PlatformAccessory
} from 'homebridge';
import { closeGarage, GarageState, openGarage, WebSocketEventTypes } from 'node-alarm-dot-com';
import { GARAGE_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { GarageContext } from '../_models/Contexts';
import { BaseHandler } from './BaseHandler';
import { HandlerContext, MANUFACTURER } from './HandlerContext';

export class GarageHandler extends BaseHandler<GarageContext, GarageState, WebSocketEventTypes> {
  constructor(ctx: HandlerContext) {
    super(ctx);
  }

  add(garage: GarageState): void {
    const { api, log, accessories, ignoredDevices } = this.ctx;
    const hap = api.hap;
    const id = garage.id;
    let accessory = accessories.find((a) => a.context.accID === id) as PlatformAccessory<GarageContext> | undefined;
    if (accessory) {
      this.ctx.removeAccessory(accessory);
    }

    const model = 'Garage Door';
    const name = garage.attributes.description;
    const uuid = hap.uuid.generate(id);
    accessory = new api.platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: garage.attributes.state,
      desiredState: garage.attributes.desiredState,
      garageType: model
    };

    if (!ignoredDevices.includes(id)) {
      log.info(
        `Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`
      );
      this.ctx.addAccessory(accessory, hap.Service.GarageDoorOpener, model);
      this.setup(accessory);
      this.stat(accessory, garage);
    }
  }

  setup(accessory: PlatformAccessory<GarageContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.garageType;

    if (!hap.Characteristic.CurrentDoorState && log.logLevel > 1) {
      throw new Error(`Unrecognized garage door opener ${id}`);
    }

    const service = accessory.getService(hap.Service.GarageDoorOpener);
    if (service === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${id}`);
    }

    service
      .setCharacteristic(hap.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hap.Characteristic.Model, model)
      .setCharacteristic(hap.Characteristic.SerialNumber, id);

    accessory.on('identify', () => {
      log.debug(`${name} identify requested`);
    });

    service.getCharacteristic(hap.Characteristic.CurrentDoorState).on('get', (callback: CharacteristicGetCallback) => {
      callback(null, accessory.context.state);
    });

    service
      .getCharacteristic(hap.Characteristic.TargetDoorState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeState(accessory, value, callback)
      );
  }

  stat(accessory: PlatformAccessory<GarageContext>, garage: GarageState): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getGarageState(garage.attributes.state, hap);
    const desiredState = getGarageState(garage.attributes.desiredState, hap);

    const garageService = accessory.getService(hap.Service.GarageDoorOpener);
    if (garageService === undefined) {
      log.error(`Garage door service was undefined when attempting to stat device with ID ${id}`);
      return;
    }

    if (state !== accessory.context.state) {
      log.info(`Updating garage ${name} (${id}), state=${state}, prev=${accessory.context.state}`);
      accessory.context.state = state;
      garageService.getCharacteristic(hap.Characteristic.CurrentDoorState).updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState;
      garageService.getCharacteristic(hap.Characteristic.TargetDoorState).updateValue(desiredState);
    }
  }

  async changeState(
    accessory: PlatformAccessory<GarageContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    let method: typeof openGarage | typeof closeGarage;

    log.debug(String(value));

    switch (value) {
      case hap.Characteristic.TargetDoorState.OPEN:
        method = openGarage;
        break;
      case hap.Characteristic.TargetDoorState.CLOSED:
        method = closeGarage;
        break;
      default: {
        const msg = `Can't set garage to unknown value ${value}`;
        log.warn(msg);
        return callback(new Error(msg));
      }
    }

    log.info(`Garage Door ${id}, ${value})`);
    accessory.context.desiredState = value;

    await this.ctx
      .loginSession()
      .then((res) => method(id, res))
      .then((res) => res.data)
      .then((garage) => {
        this.stat(accessory, garage);
      })
      .then(() => callback())
      .catch((err) => {
        log.error(`Error: Failed to change garage state: ${err.stack}`);
        this.ctx.refreshDevices();
        callback(err);
      });
  }

  statFromWebSocket(accessory: PlatformAccessory<GarageContext>, eventType: WebSocketEventTypes): boolean {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    const service = accessory.getService(hap.Service.GarageDoorOpener);
    if (!service) return false;

    let state: number;
    if (eventType === WebSocketEventTypes.Opened) {
      state = hap.Characteristic.CurrentDoorState.OPEN;
    } else {
      state = hap.Characteristic.CurrentDoorState.CLOSED;
    }

    if (state !== accessory.context.state) {
      log.info(`Updating garage ${name} (${id}), state=${state}, prev=${accessory.context.state}`);
      accessory.context.state = state;
      service.getCharacteristic(hap.Characteristic.CurrentDoorState).updateValue(state);
    }

    if (state !== accessory.context.desiredState) {
      accessory.context.desiredState = state;
      service.getCharacteristic(hap.Characteristic.TargetDoorState).updateValue(state);
    }

    return true;
  }
}

function getGarageState(state: number, hap: HAP): CharacteristicValue {
  switch (state) {
    case GARAGE_STATES.OPEN:
      return hap.Characteristic.CurrentDoorState.OPEN;
    case GARAGE_STATES.CLOSED:
      return hap.Characteristic.CurrentDoorState.CLOSED;
    default:
      return hap.Characteristic.CurrentDoorState.STOPPED;
  }
}
