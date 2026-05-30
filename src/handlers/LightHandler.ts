import {
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  PlatformAccessory,
  PlatformAccessoryEvent
} from 'homebridge';
import { LightState, setLightOff, setLightOn, WebSocketEvent, WebSocketEventTypes } from 'node-alarm-dot-com';
import { LIGHT_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { LightContext } from '../_models/Contexts';
import { HandlerContext, MANUFACTURER } from './HandlerContext';

export class LightHandler {
  constructor(private readonly ctx: HandlerContext) {}

  add(light: LightState): void {
    const { api, log, accessories, ignoredDevices } = this.ctx;
    const hap = api.hap;
    const id = light.id;
    let accessory = accessories.find((a) => a.context.accID === id) as PlatformAccessory<LightContext> | undefined;
    if (accessory) {
      this.ctx.removeAccessory(accessory);
    }

    const model = 'Light';
    const name = light.attributes.description;
    const uuid = hap.uuid.generate(id);
    accessory = new api.platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: light.attributes.state,
      desiredState: light.attributes.desiredState,
      isDimmer: light.attributes.isDimmer,
      lightLevel: light.attributes.lightLevel,
      lightType: model
    };

    if (!ignoredDevices.includes(id)) {
      log.info(
        `Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`
      );
      this.ctx.addAccessory(accessory, hap.Service.Lightbulb, model);
      this.setup(accessory);
      this.stat(accessory, light);
    }
  }

  setup(accessory: PlatformAccessory<LightContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.lightType;

    const informationService = accessory.getService(hap.Service.AccessoryInformation);
    if (informationService === undefined) {
      log.error(`Trouble getting HomeKit accessory information for ${id}`);
      return;
    }

    informationService
      .setCharacteristic(hap.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hap.Characteristic.Model, model)
      .setCharacteristic(hap.Characteristic.SerialNumber, id);

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(hap.Service.Lightbulb);
    if (service === undefined) {
      log.error(`Error getting lightbulb information for device with id ${id}`);
      return;
    }

    service
      .getCharacteristic(hap.Characteristic.On)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.state);
      })
      .on('set', (desiredState: CharacteristicValue, callback: CharacteristicSetCallback) => {
        this.changeLight(accessory, desiredState as boolean, callback);
      });

    if (accessory.context.isDimmer) {
      service
        .getCharacteristic(hap.Characteristic.Brightness)
        .on('get', (callback: CharacteristicGetCallback) => {
          callback(null, accessory.context.lightLevel);
        })
        .on('set', (brightness: CharacteristicValue, callback: CharacteristicSetCallback) => {
          this.changeLightBrightness(accessory, brightness as number, callback);
        });
    }
  }

  stat(accessory: PlatformAccessory<LightContext>, light: LightState, callback?: CharacteristicSetCallback): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const newState = getLightState(light.attributes.state);
    const newBrightness = light.attributes.lightLevel;
    const service = accessory.getService(hap.Service.Lightbulb);

    if (service === undefined) {
      log.error(`Unable to get service information for lightbulb with id ${id}`);
      return;
    }

    if (newState !== accessory.context.state) {
      log.info(`Updating light ${name} (${id}), state=${newState}, prev=${accessory.context.state}`);
      accessory.context.state = newState;
      service.updateCharacteristic(hap.Characteristic.On, newState);
    }

    if (accessory.context.isDimmer && newBrightness !== accessory.context.lightLevel) {
      accessory.context.lightLevel = newBrightness;
      service.updateCharacteristic(hap.Characteristic.Brightness, newBrightness);
    }

    if (callback !== undefined && callback !== null) {
      callback();
    }
  }

  async changeLightBrightness(
    accessory: PlatformAccessory<LightContext>,
    brightness: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const { log } = this.ctx;
    const id = accessory.context.accID;

    log.info(`Changing light (${id}, light level ${brightness})`);
    accessory.context.lightLevel = brightness;

    await this.ctx
      .loginSession()
      .then((res) => setLightOn(id, res, accessory.context.lightLevel, accessory.context.isDimmer))
      .then((res) => res.data)
      .then((light) => {
        this.stat(accessory, light, callback);
      })
      .catch((err) => {
        log.error(`Error: Failed to change light state: ${err.stack}`);
        this.ctx.refreshDevices();
        callback(err);
      });
  }

  async changeLight(
    accessory: PlatformAccessory<LightContext>,
    desiredState: boolean,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    if (desiredState === accessory.context.state) {
      callback();
      return;
    }

    const { log } = this.ctx;
    const id = accessory.context.accID;
    const method = desiredState ? setLightOn : setLightOff;

    log.info(`Changing light (${id}, ${desiredState})`);
    accessory.context.state = desiredState;

    await this.ctx
      .loginSession()
      .then((res) => method(id, res, accessory.context.lightLevel ?? 100, accessory.context.isDimmer))
      .then((res) => res.data)
      .then((light) => {
        this.stat(accessory, light, callback);
      })
      .catch((err) => {
        log.error(`Error: Failed to change light state: ${err.stack}`);
        this.ctx.refreshDevices();
        callback(err);
      });
  }

  statFromWebSocket(accessory: PlatformAccessory<LightContext>, event: WebSocketEvent): boolean {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    const service = accessory.getService(hap.Service.Lightbulb);
    if (!service) return false;

    switch (event.EventType as WebSocketEventTypes) {
      case WebSocketEventTypes.LightTurnedOn: {
        if (accessory.context.state !== true) {
          log.info(`Updating light ${name} (${id}), state=true, prev=${accessory.context.state}`);
          accessory.context.state = true;
          service.updateCharacteristic(hap.Characteristic.On, true);
        }
        break;
      }
      case WebSocketEventTypes.LightTurnedOff: {
        if (accessory.context.state !== false) {
          log.info(`Updating light ${name} (${id}), state=false, prev=${accessory.context.state}`);
          accessory.context.state = false;
          service.updateCharacteristic(hap.Characteristic.On, false);
        }
        break;
      }
      case WebSocketEventTypes.SwitchLevelChanged: {
        const brightness = event.EventValue;
        if (accessory.context.state !== true) {
          accessory.context.state = true;
          service.updateCharacteristic(hap.Characteristic.On, true);
        }
        if (accessory.context.isDimmer && brightness !== accessory.context.lightLevel) {
          log.info(`Updating light ${name} (${id}), brightness=${brightness}, prev=${accessory.context.lightLevel}`);
          accessory.context.lightLevel = brightness;
          service.updateCharacteristic(hap.Characteristic.Brightness, brightness);
        }
        break;
      }
    }

    return true;
  }

  refresh(light: LightState): void {
    const { accessories, ignoredDevices } = this.ctx;
    const accessory = accessories.find((a) => a.context.accID === light.id) as
      | PlatformAccessory<LightContext>
      | undefined;
    if (!ignoredDevices.includes(light.id)) {
      if (!accessory) {
        return this.add(light);
      }
      this.stat(accessory, light);
    }
  }
}

function getLightState(state: number): CharacteristicValue {
  switch (state) {
    case LIGHT_STATES.OFF:
      return false;
    case LIGHT_STATES.ON:
      return true;
    default:
      return -1;
  }
}
