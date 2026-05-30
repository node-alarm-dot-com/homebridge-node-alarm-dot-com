import { PlatformAccessory } from 'homebridge';
import { DeviceState } from 'node-alarm-dot-com';
import { BaseContext } from '../_models/Contexts';
import { HandlerContext } from './HandlerContext';

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
}
