import {
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  PlatformAccessory
} from 'homebridge';
import {
  armAway,
  armStay,
  disarm,
  PartitionActionOptions,
  PartitionState,
  WebSocketEventTypes
} from 'node-alarm-dot-com';
import { SYSTEM_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { PartitionContext } from '../_models/Contexts';
import { BaseHandler } from './BaseHandler';
import { HandlerContext, MANUFACTURER } from './HandlerContext';

export class PartitionHandler extends BaseHandler<PartitionContext, PartitionState, WebSocketEventTypes> {
  constructor(ctx: HandlerContext) {
    super(ctx);
  }

  add(partition: PartitionState): void {
    const { api, log, accessories } = this.ctx;
    const hap = api.hap;
    const id = partition.id;
    let accessory = accessories.find((a) => a.context.accID === id) as PlatformAccessory<PartitionContext>;
    if (accessory) {
      this.ctx.removeAccessory(accessory);
    }

    const name = partition.attributes.description;
    const uuid = hap.uuid.generate(id);
    accessory = new api.platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: SYSTEM_STATES.UNKNOWN,
      desiredState: SYSTEM_STATES.UNKNOWN,
      statusFault: false,
      partitionType: 'default'
    };

    log.info(`Adding partition ${name} (id=${id}, uuid=${uuid})`);

    this.ctx.addAccessory(accessory, hap.Service.SecuritySystem, 'Security Panel');
    this.setup(accessory);
    this.stat(accessory, partition);
  }

  setup(accessory: PlatformAccessory<PartitionContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = 'Security Panel';

    const informationService = accessory.getService(hap.Service.AccessoryInformation);
    if (informationService === undefined) {
      log.error(`Trouble getting HomeKit accessory information for ${id}`);
      return;
    }

    informationService
      .setCharacteristic(hap.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hap.Characteristic.Model, model)
      .setCharacteristic(hap.Characteristic.SerialNumber, id);

    accessory.on('identify', () => {
      log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(hap.Service.SecuritySystem);
    if (service === undefined) {
      log.error(`Trouble getting service for partition with id ${id}`);
      return;
    }

    service
      .getCharacteristic(hap.Characteristic.SecuritySystemCurrentState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.state));

    service
      .getCharacteristic(hap.Characteristic.SecuritySystemTargetState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeState(accessory, value, callback)
      );

    service
      .getCharacteristic(hap.Characteristic.StatusFault)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.statusFault));
  }

  stat(accessory: PlatformAccessory<PartitionContext>, partition: PartitionState): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getPartitionState(partition.attributes.state, hap);
    const desiredState = getPartitionState(partition.attributes.desiredState, hap);
    const statusFault = Boolean(partition.attributes.needsClearIssuesPrompt);

    const service = accessory.getService(hap.Service.SecuritySystem);
    if (service === undefined) {
      log.error(`Error getting service for partition with id ${id}`);
      return;
    }

    if (state !== accessory.context.state) {
      log.debug(`Updating partition ${name} (${id}), state=${state}, prev=${accessory.context.state}`);
      accessory.context.state = state;
      service.getCharacteristic(hap.Characteristic.SecuritySystemCurrentState).updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      log.info(
        `Updating partition ${name} (${id}), desiredState=${desiredState}, prev=${accessory.context.desiredState}`
      );
      accessory.context.desiredState = desiredState;
      service.getCharacteristic(hap.Characteristic.SecuritySystemTargetState).updateValue(desiredState);
    }

    if (statusFault !== accessory.context.statusFault) {
      log.info(`Updating partition ${name} (${id}), statusFault=${statusFault}, prev=${accessory.context.statusFault}`);
      accessory.context.statusFault = statusFault;
      service.getCharacteristic(hap.Characteristic.StatusFault).updateValue(statusFault);
    }
  }

  async changeState(
    accessory: PlatformAccessory<PartitionContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const { api, log, armingModes } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    let method: typeof armAway | typeof armStay | typeof disarm;
    const opts = {} as PartitionActionOptions;

    switch (value) {
      case hap.Characteristic.SecuritySystemTargetState.STAY_ARM:
        method = armStay;
        opts.noEntryDelay = armingModes.stay.noEntryDelay;
        opts.silentArming = armingModes.stay.silentArming;
        opts.nightArming = armingModes.stay.nightArming;
        opts.forceBypass = armingModes.stay.forceBypass;
        break;
      case hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM:
        method = armStay;
        opts.noEntryDelay = armingModes.night.noEntryDelay;
        opts.silentArming = armingModes.night.silentArming;
        opts.nightArming = armingModes.night.nightArming;
        opts.forceBypass = armingModes.night.forceBypass;
        break;
      case hap.Characteristic.SecuritySystemTargetState.AWAY_ARM:
        method = armAway;
        opts.noEntryDelay = armingModes.away.noEntryDelay;
        opts.silentArming = armingModes.away.silentArming;
        opts.nightArming = armingModes.away.nightArming;
        opts.forceBypass = armingModes.away.forceBypass;
        break;
      case hap.Characteristic.SecuritySystemTargetState.DISARM:
        method = disarm;
        break;
      default: {
        const msg = `Can't set SecuritySystem to unknown value ${value}`;
        log.warn(msg);
        return callback(new Error(msg));
      }
    }

    log.info(`changePartitionState(${id}, ${value})`);
    accessory.context.desiredState = value;

    await this.ctx
      .loginSession()
      .then((res) => method(id, res, opts))
      .then((res) => res.data)
      .then((partition) => this.stat(accessory, partition))
      .then(() => callback())
      .catch((err) => {
        log.error(`Error: Failed to change partition state: ${err.stack}`);
        this.ctx.refreshDevices();
        callback(err);
      });
  }

  statFromWebSocket(accessory: PlatformAccessory<PartitionContext>, eventType: WebSocketEventTypes): boolean {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    const service = accessory.getService(hap.Service.SecuritySystem);
    if (!service) return false;

    let currentState: number;
    let targetState: number;

    switch (eventType) {
      case WebSocketEventTypes.Disarmed:
        currentState = hap.Characteristic.SecuritySystemCurrentState.DISARMED;
        targetState = hap.Characteristic.SecuritySystemTargetState.DISARM;
        break;
      case WebSocketEventTypes.ArmedStay:
        currentState = hap.Characteristic.SecuritySystemCurrentState.STAY_ARM;
        targetState = hap.Characteristic.SecuritySystemTargetState.STAY_ARM;
        break;
      case WebSocketEventTypes.ArmedAway:
        currentState = hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
        targetState = hap.Characteristic.SecuritySystemTargetState.AWAY_ARM;
        break;
      case WebSocketEventTypes.ArmedNight:
        currentState = hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
        targetState = hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM;
        break;
      default:
        return false;
    }

    if (currentState !== accessory.context.state) {
      log.info(`Updating partition ${name} (${id}), state=${currentState}, prev=${accessory.context.state}`);
      accessory.context.state = currentState;
      service.getCharacteristic(hap.Characteristic.SecuritySystemCurrentState).updateValue(currentState);
    }

    if (targetState !== accessory.context.desiredState) {
      log.info(
        `Updating partition ${name} (${id}), desiredState=${targetState}, prev=${accessory.context.desiredState}`
      );
      accessory.context.desiredState = targetState;
      service.getCharacteristic(hap.Characteristic.SecuritySystemTargetState).updateValue(targetState);
    }

    return true;
  }
}

function getPartitionState(state: number, hap: HAP): number {
  switch (state) {
    case SYSTEM_STATES.ARMED_STAY:
      return hap.Characteristic.SecuritySystemCurrentState.STAY_ARM;
    case SYSTEM_STATES.ARMED_AWAY:
      return hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    case SYSTEM_STATES.ARMED_NIGHT:
      return hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
    case SYSTEM_STATES.UNKNOWN:
    case SYSTEM_STATES.DISARMED:
    default:
      return hap.Characteristic.SecuritySystemCurrentState.DISARMED;
  }
}
