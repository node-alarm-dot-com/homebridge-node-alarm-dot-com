import { PlatformAccessory, PlatformAccessoryEvent } from 'homebridge';
import { DeviceState } from 'node-alarm-dot-com';
import { BaseContext } from '../_models/Contexts';
import { HandlerContext, MANUFACTURER } from './HandlerContext';

export abstract class BaseHandler<TContext extends BaseContext, TDeviceState extends DeviceState, TWsArg> {
  constructor(protected readonly ctx: HandlerContext) {}

  abstract add(device: TDeviceState): void;
  abstract setup(accessory: PlatformAccessory<TContext>): void;
  abstract stat(accessory: PlatformAccessory<TContext>, device: TDeviceState): void;
  abstract statFromWebSocket(accessory: PlatformAccessory<TContext>, arg: TWsArg): boolean | void;

  refresh(device: TDeviceState): void {
    const { accessories, ignoredDevices } = this.ctx;
    const accessory = accessories.find((a) => a.context.accID === device.id) as PlatformAccessory<TContext> | undefined;
    if (!ignoredDevices.includes(device.id)) {
      if (!accessory) {
        return this.add(device);
      }
      this.stat(accessory, device);
    }
  }

  protected createAccessory(id: string, name: string): PlatformAccessory<TContext> {
    const { api, accessories } = this.ctx;
    const existing = accessories.find((a) => a.context.accID === id) as PlatformAccessory<TContext> | undefined;
    if (existing) this.ctx.removeAccessory(existing);
    const uuid = api.hap.uuid.generate(id);
    return new api.platformAccessory(name, uuid) as unknown as PlatformAccessory<TContext>;
  }

  protected setAccessoryInfo(accessory: PlatformAccessory<TContext>, model: string): void {
    const hap = this.ctx.api.hap;
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.setCharacteristic(hap.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hap.Characteristic.Model, model)
      .setCharacteristic(hap.Characteristic.SerialNumber, accessory.context.accID);
  }

  protected registerIdentify(accessory: PlatformAccessory<TContext>): void {
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.ctx.log.debug(`${accessory.context.name} identify requested`);
    });
  }
}
