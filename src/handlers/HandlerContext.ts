import { API, PlatformAccessory, Service } from 'homebridge';
import { AuthOpts } from 'node-alarm-dot-com';
import { CustomLogger } from '../CustomLogger';
import { BaseContext } from '../_models/Contexts';
import { ArmingModes } from '../_models/PluginPlatformConfig';

export const MANUFACTURER = 'Alarm.com';

export interface HandlerContext {
  readonly api: API;
  readonly log: CustomLogger;
  readonly accessories: ReadonlyArray<PlatformAccessory<BaseContext>>;
  readonly ignoredDevices: string[];
  readonly armingModes: ArmingModes;
  readonly tempDisplayUnitSetting: number;
  readonly supportAnyDoorbellCamera: boolean;
  loginSession(): Promise<AuthOpts>;
  refreshDevices(): Promise<void>;
  addAccessory(accessory: PlatformAccessory<BaseContext>, type: typeof Service, model: string): void;
  removeAccessory(accessory?: PlatformAccessory<BaseContext>): void;
}
