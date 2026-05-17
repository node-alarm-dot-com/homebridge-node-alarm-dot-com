import {
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  PlatformAccessory,
  PlatformAccessoryEvent
} from 'homebridge';
import { LockState, setLockSecure, setLockUnsecure } from 'node-alarm-dot-com';
import { LOCK_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { LockContext } from '../_models/Contexts';
import { HandlerContext, MANUFACTURER } from './HandlerContext';

export class LockHandler {
  constructor(private readonly ctx: HandlerContext) {}

  add(lock: LockState): void {
    const { api, log, accessories, ignoredDevices } = this.ctx;
    const hap = api.hap;
    const id = lock.id;
    let accessory = accessories.find((a) => a.context.accID === id) as PlatformAccessory<LockContext> | undefined;
    if (accessory) {
      this.ctx.removeAccessory(accessory);
    }

    const model = 'Door Lock';
    const name = lock.attributes.description;
    const uuid = hap.uuid.generate(id);
    accessory = new api.platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: lock.attributes.state,
      desiredState: lock.attributes.desiredState,
      lockType: model
    };

    if (!ignoredDevices.includes(id)) {
      log.info(
        `Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`
      );
      this.ctx.addAccessory(accessory, hap.Service.LockMechanism, model);
      this.setup(accessory);
      this.stat(accessory, lock);
    }
  }

  setup(accessory: PlatformAccessory<LockContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.lockType;

    if (!hap.Characteristic.LockCurrentState && log.logLevel > 1) {
      throw new Error(`Unrecognized lock ${id}`);
    }

    const homeKitService = accessory.getService(hap.Service.AccessoryInformation);
    if (homeKitService === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${id}`);
    }

    homeKitService
      .setCharacteristic(hap.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hap.Characteristic.Model, model)
      .setCharacteristic(hap.Characteristic.SerialNumber, id);

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(hap.Service.LockMechanism);
    if (service === undefined) {
      throw new Error(`Trouble getting service for ${id}`);
    }

    service.getCharacteristic(hap.Characteristic.LockCurrentState).on('get', (callback: CharacteristicGetCallback) => {
      callback(null, accessory.context.state);
    });

    service
      .getCharacteristic(hap.Characteristic.LockTargetState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeState(accessory, value, callback)
      );
  }

  stat(accessory: PlatformAccessory<LockContext>, lock: LockState): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getLockCurrentState(lock.attributes.state, hap);
    const desiredState = getLockTargetState(lock.attributes.desiredState, hap);

    const service = accessory.getService(hap.Service.LockMechanism);
    if (service === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${id}`);
    }

    if (state !== accessory.context.state) {
      log.info(`Updating lock ${name} (${id}), state=${state}, prev=${accessory.context.state}`);
      accessory.context.state = state;
      service.getCharacteristic(hap.Characteristic.LockCurrentState).updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState;
      service.getCharacteristic(hap.Characteristic.LockTargetState).updateValue(desiredState);
    }
  }

  async changeState(
    accessory: PlatformAccessory<LockContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    let method: typeof setLockSecure | typeof setLockUnsecure;

    switch (value) {
      case hap.Characteristic.LockTargetState.UNSECURED:
        method = setLockUnsecure;
        break;
      case hap.Characteristic.LockTargetState.SECURED:
        method = setLockSecure;
        break;
      default: {
        const msg = `Can't set LockMechanism to unknown value ${value}`;
        log.warn(msg);
        return callback(new Error(msg));
      }
    }

    log.info(`(un)secureLock(${id}, ${value})`);
    accessory.context.desiredState = value;

    await this.ctx
      .loginSession()
      .then((res) => method(id, res))
      .then((res) => res.data)
      .then((lock) => {
        this.stat(accessory, lock);
      })
      .then(() => callback())
      .catch((err) => {
        log.error(`Error: Failed to change lock state: ${err.stack}`);
        this.ctx.refreshDevices();
        callback(err);
      });
  }

  refresh(lock: LockState): void {
    const { accessories, ignoredDevices } = this.ctx;
    const accessory = accessories.find((a) => a.context.accID === lock.id) as
      | PlatformAccessory<LockContext>
      | undefined;
    if (!ignoredDevices.includes(lock.id)) {
      if (!accessory) {
        return this.add(lock);
      }
      this.stat(accessory, lock);
    }
  }
}

function getLockCurrentState(state: LOCK_STATES, hap: HAP): CharacteristicValue {
  switch (state) {
    case LOCK_STATES.UNSECURED:
      return hap.Characteristic.LockCurrentState.UNSECURED;
    case LOCK_STATES.SECURED:
      return hap.Characteristic.LockCurrentState.SECURED;
    default:
      return hap.Characteristic.LockCurrentState.SECURED;
  }
}

function getLockTargetState(state: LOCK_STATES, hap: HAP): CharacteristicValue {
  switch (state) {
    case LOCK_STATES.UNSECURED:
      return hap.Characteristic.LockTargetState.UNSECURED;
    case LOCK_STATES.SECURED:
      return hap.Characteristic.LockTargetState.SECURED;
    default:
      return hap.Characteristic.LockTargetState.SECURED;
  }
}
