import {
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  PlatformAccessory
} from 'homebridge';
import { LockState, setLockSecure, setLockUnsecure } from 'node-alarm-dot-com';
import { LOCK_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { LockContext } from '../_models/Contexts';
import { BaseHandler } from './BaseHandler';
import { HandlerContext } from './HandlerContext';

export class LockHandler extends BaseHandler<LockContext, LockState, boolean> {
  constructor(ctx: HandlerContext) {
    super(ctx);
  }

  add(lock: LockState): void {
    const { api, log, ignoredDevices } = this.ctx;
    const hap = api.hap;
    const id = lock.id;
    const model = 'Door Lock';
    const name = lock.attributes.description;
    const accessory = this.createAccessory(id, name);

    accessory.context = {
      accID: id,
      name: name,
      state: lock.attributes.state,
      desiredState: lock.attributes.desiredState,
      lockType: model
    };

    if (!ignoredDevices.includes(id)) {
      log.info(
        `Adding ${model} "${name}" (id=${id}, uuid=${accessory.UUID}) (${accessory.context.state} ${accessory.context.desiredState})`
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
    const model = accessory.context.lockType;

    if (!hap.Characteristic.LockCurrentState && log.logLevel > 1) {
      log.error(`Unrecognized lock ${id}`);
      return;
    }

    this.setAccessoryInfo(accessory, model);
    this.registerIdentify(accessory);

    const service = accessory.getService(hap.Service.LockMechanism);
    if (service === undefined) {
      log.error(`Trouble getting service for ${id}`);
      return;
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
      log.error(`Trouble getting HomeKit accessory information for ${id}`);
      return;
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

  /**
   * This function is used to update a locks state from a WebSocket event
   * @param accessory The Lock to update.
   * @param isLocked Whether the lock is locked.
   */
  statFromWebSocket(accessory: PlatformAccessory<LockContext>, isLocked: boolean): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    const state = isLocked
      ? hap.Characteristic.LockCurrentState.SECURED
      : hap.Characteristic.LockCurrentState.UNSECURED;
    const desiredState = isLocked
      ? hap.Characteristic.LockTargetState.SECURED
      : hap.Characteristic.LockTargetState.UNSECURED;

    const service = accessory.getService(hap.Service.LockMechanism);
    if (service === undefined) {
      log.error(`Trouble getting service for lock ${id}`);
      return;
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
