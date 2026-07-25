import { PlatformConfig } from 'homebridge';

export type ArmingModeOptions = {
  nightArming: boolean;
  noEntryDelay: boolean;
  silentArming: boolean;
  forceBypass: boolean;
};

export type ArmingModes = {
  stay: ArmingModeOptions;
  night: ArmingModeOptions;
  away: ArmingModeOptions;
};

export type PluginPlatformConfig = PlatformConfig & {
  logLevel?: 0 | 1 | 2 | 3 | 4;
  ignoredDevices?: string[];
  useMFA?: boolean;
  mfaCookie?: string;
  authTimeoutMinutes?: number;
  pollTimeoutSeconds?: number;
  username?: string;
  password?: string;
  armingModes?: Partial<Record<keyof ArmingModes, Partial<ArmingModeOptions>>>;
  supportAnyDoorbellCamera?: boolean;
};
