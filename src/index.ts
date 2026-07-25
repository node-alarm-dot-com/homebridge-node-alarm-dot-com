import { API, APIEvent, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import fs from 'fs';

import {
  AuthOpts,
  CAMERA_EVENT_TYPES,
  CameraState,
  DeviceState,
  FlattenedSystemState,
  GARAGE_EVENT_TYPES,
  GarageState,
  getCurrentState,
  getIdentitiesState,
  getPartitions,
  getSensors,
  getThermostats,
  getWebSocketToken,
  LIGHT_EVENT_TYPES,
  LightState,
  LOCK_EVENT_TYPES,
  LockState,
  login,
  PARTITION_EVENT_TYPES,
  PartitionState,
  SENSOR_EVENT_TYPES,
  SensorState,
  THERMOSTAT_EVENT_TYPES,
  ThermostatState,
  WebSocketEvent,
  WebSocketEventTypes
} from 'node-alarm-dot-com';

import path from 'path';

import { describeError } from 'node-alarm-dot-com/dist/_utils';
import {
  BaseContext,
  isDoorbell,
  isGarage,
  isLight,
  isLock,
  isPartition,
  isSensor,
  isThermostat
} from './_models/Contexts';
import { ArmingModes, PluginPlatformConfig } from './_models/PluginPlatformConfig';
import { SimplifiedSystemState } from './_models/SimplifiedSystemState';
import { CustomLogger, CustomLogLevel } from './CustomLogger';
import { DoorbellHandler } from './handlers/DoorbellHandler';
import { GarageHandler } from './handlers/GarageHandler';
import { MANUFACTURER } from './handlers/HandlerContext';
import { LightHandler } from './handlers/LightHandler';
import { LockHandler } from './handlers/LockHandler';
import { PartitionHandler } from './handlers/PartitionHandler';
import { SensorHandler } from './handlers/SensorHandler';
import { ThermostatHandler } from './handlers/ThermostatHandler';

const PLUGIN_ID = 'homebridge-node-alarm-dot-com';
const PLUGIN_NAME = 'Alarmdotcom';
const AUTH_TIMEOUT_MINS = 10;
const POLL_TIMEOUT_SECS = 60;
const WS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const WS_REFRESH_JITTER_MS = 15 * 1000;
const WS_MAX_CONSECUTIVE_FAILURES = 5;
const HOURLY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const LOG_LEVEL = CustomLogLevel.WARN;

export = (api: API): void => {
  api.registerPlatform(PLUGIN_ID, PLUGIN_NAME, ADCPlatform);
};

class ADCPlatform implements DynamicPlatformPlugin {
  public readonly log: CustomLogger;
  public readonly api: API;

  readonly accessories: PlatformAccessory<BaseContext>[] = [];
  private readonly accessoriesToUpdate: PlatformAccessory<BaseContext>[] = [];

  private authOpts: AuthOpts;
  private config: PluginPlatformConfig;
  private username: string;
  private password: string;
  private readonly logLevel: CustomLogLevel;
  private useMFA: boolean;
  private mfaToken?: string;
  tempDisplayUnitSetting: number;
  armingModes: ArmingModes;
  ignoredDevices: string[];
  private authTimeoutMinutes: number;
  private pollTimeoutSeconds: number;
  private timerHandle: NodeJS.Timeout | undefined;
  private wsClient: WebSocket | undefined;
  private isShuttingDown = false;
  private unmatchedDeviceRefreshHandle: NodeJS.Timeout | undefined;
  private wsRefreshHandle: NodeJS.Timeout | undefined;
  private hourlyRefreshHandle: NodeJS.Timeout | undefined;
  private wsConsecutiveFailures = 0;

  private readonly partitionHandler: PartitionHandler;
  private readonly sensorHandler: SensorHandler;
  private readonly lightHandler: LightHandler;
  private readonly lockHandler: LockHandler;
  private readonly garageHandler: GarageHandler;
  private readonly thermostatHandler: ThermostatHandler;
  private readonly doorbellHandler: DoorbellHandler;

  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.api = api;
    this.config = config ?? { platform: PLUGIN_NAME };
    this.username = this.config.username ?? '';
    this.password = this.config.password ?? '';
    this.logLevel = this.config.logLevel ?? LOG_LEVEL;
    this.log = new CustomLogger(log, this.logLevel);
    this.ignoredDevices = this.config.ignoredDevices ?? [];
    this.useMFA = this.config.useMFA ?? false;
    this.mfaToken = this.config.useMFA ? this.config.mfaCookie : undefined;
    this.tempDisplayUnitSetting = api.hap.Characteristic.TemperatureDisplayUnits.CELSIUS;

    this.authTimeoutMinutes = this.config.authTimeoutMinutes ?? AUTH_TIMEOUT_MINS;
    this.pollTimeoutSeconds = this.config.pollTimeoutSeconds ?? POLL_TIMEOUT_SECS;

    this.authOpts = {
      expires: +new Date() - 1
    } as AuthOpts;

    this.armingModes = {
      away: {
        nightArming: false,
        noEntryDelay: false,
        silentArming: false,
        forceBypass: false
      },
      night: {
        nightArming: true,
        noEntryDelay: false,
        silentArming: true,
        forceBypass: false
      },
      stay: {
        nightArming: false,
        noEntryDelay: false,
        silentArming: true,
        forceBypass: false
      }
    };

    if (this.config.armingModes !== undefined) {
      for (const key in this.config.armingModes) {
        const mode = key as keyof ArmingModes;
        const modeOptions = this.config.armingModes[mode];
        if (modeOptions) {
          this.armingModes[mode].nightArming = Boolean(modeOptions.nightArming);
          this.armingModes[mode].noEntryDelay = Boolean(modeOptions.noEntryDelay);
          this.armingModes[mode].silentArming = Boolean(modeOptions.silentArming);
          this.armingModes[mode].forceBypass = Boolean(modeOptions.forceBypass);
        }
      }
    }

    this.partitionHandler = new PartitionHandler(this);
    this.sensorHandler = new SensorHandler(this);
    this.lightHandler = new LightHandler(this);
    this.lockHandler = new LockHandler(this);
    this.garageHandler = new GarageHandler(this);
    this.thermostatHandler = new ThermostatHandler(this);
    this.doorbellHandler = new DoorbellHandler(this);

    if (!api && !config) {
      return;
    } else {
      this.api = api;

      if (!this.username) {
        this.log.error(MANUFACTURER + ': Missing required username in config');
        return;
      }
      if (!this.password) {
        this.log.error(MANUFACTURER + ': Missing required password in config');
        return;
      }

      this.api.on(APIEvent.DID_FINISH_LAUNCHING, this.registerAlarmSystem.bind(this));
      this.api.on(APIEvent.SHUTDOWN, this.cleanup.bind(this));
    }
  }

  // List and Add Devices //////////////////////////////////////////////////////

  async registerAlarmSystem() {
    this.accessories.forEach((accessory) => {
      const ignored = this.ignoredDevices.indexOf(accessory.context.accID) > -1;
      if (ignored) {
        this.log.debug(`Removing ignored device ${accessory.context.accID} from homebridge`);
        this.removeAccessory(accessory);
      }
    });

    this.accessoriesToUpdate.forEach((accessory) => {
      this.removeAccessory(accessory);
    });

    await this.getAccountSettings();

    this.listDevices()
      .then((res) => {
        this.log.debug('Registering system:');
        this.log.debug(JSON.stringify(res));

        for (const device in res) {
          const key = device as keyof SimplifiedSystemState;
          if (device === 'partitions' && typeof res[key][0] === 'undefined') {
            this.log.debug(`Received no partitions from Alarm.com.`);
          } else if (res[key].length > 0) {
            this.log.info(`Received ${res[key].length} ${device} from Alarm.com`);

            res[key].forEach((d: DeviceState) => {
              const deviceType = d.type;
              const realDeviceType = deviceType.split('/')[1];
              if (!this.ignoredDevices.includes(d.id)) {
                const uuid = this.api.hap.uuid.generate(d.id);
                const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
                if (!existingAccessory) {
                  if (key === 'cameras') {
                    this.doorbellHandler.add(d as CameraState);
                  } else if (realDeviceType === 'partition') {
                    this.partitionHandler.add(d as PartitionState);
                  } else if (realDeviceType === 'sensor') {
                    this.sensorHandler.add(d as SensorState);
                  } else if (realDeviceType === 'light') {
                    this.lightHandler.add(d as LightState);
                  } else if (realDeviceType === 'lock') {
                    this.lockHandler.add(d as LockState);
                  } else if (realDeviceType === 'garage-door') {
                    this.garageHandler.add(d as GarageState);
                  } else if (realDeviceType === 'thermostat') {
                    this.thermostatHandler.add(d as ThermostatState);
                  }

                  this.log.info(`Added ${realDeviceType} ${d.attributes.description} (${d.id})`);
                } else {
                  this.log.info(`Restoring accessory with ID ${d.id}`);
                }
              } else {
                this.log.info(`Ignored sensor ${d.attributes.description} (${d.id})`);
              }
            });
          } else {
            this.log.debug(`Received no ${device} from Alarm.com. If you are expecting
              ${device} in your Alarm.com setup, you may need to check that your
              provider has assigned ${device} in your Alarm.com account`);
          }
        }
      })
      .catch((err) => {
        this.log.error(`Error: ${err.stack}`);
      });

    this.setupWebSocket();
    this.hourlyRefreshLoop();
  }

  cleanup(): void {
    this.log.info('Cleaning up homebridge-node-alarm-dot-com');
    this.isShuttingDown = true;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    if (this.unmatchedDeviceRefreshHandle) {
      clearTimeout(this.unmatchedDeviceRefreshHandle);
      this.unmatchedDeviceRefreshHandle = undefined;
    }
    if (this.wsRefreshHandle) {
      clearTimeout(this.wsRefreshHandle);
      this.wsRefreshHandle = undefined;
    }
    if (this.hourlyRefreshHandle) {
      clearTimeout(this.hourlyRefreshHandle);
      this.hourlyRefreshHandle = undefined;
    }
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = undefined;
    }
  }

  hourlyRefreshLoop(): void {
    this.hourlyRefreshHandle = setTimeout(() => {
      this.log.debug('Performing hourly safety-net device refresh...');
      this.refreshDevices();
      this.hourlyRefreshLoop();
    }, HOURLY_REFRESH_INTERVAL_MS);
  }

  timerLoop(): void {
    const timerDelay = this.pollTimeoutSeconds * 1000 + 30000 * Math.random();
    this.timerHandle = setTimeout(() => {
      this.refreshDevices();
      this.timerLoop();
    }, timerDelay);
  }

  private async setupWebSocket(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      const authOpts = await this.loginSession();
      const tokenResponse = await getWebSocketToken(authOpts);
      const wsUrl = `${tokenResponse.endpoint}?auth=${tokenResponse.value}`;

      if (this.wsClient) {
        this.wsClient.onclose = null;
        this.wsClient.close();
        this.wsClient = undefined;
      }

      this.log.info('Connecting to Alarm.com WebSocket...');
      this.wsClient = new WebSocket(wsUrl);

      this.wsClient.onmessage = (event) => {
        try {
          const wsEvent: WebSocketEvent = JSON.parse(event.data as string);
          this.log.debug(`WebSocket event received: ${JSON.stringify(wsEvent)}`);
          this.refreshDeviceFromWebSocket(wsEvent, authOpts);
        } catch (err) {
          this.log.error(`Failed to parse WebSocket message: ${err}`);
        }
      };

      this.wsClient.onclose = () => {
        if (this.isShuttingDown) {
          this.log.info('WebSocket connection closed.');
          return;
        }
        this.log.info('WebSocket connection closed.');
        this.scheduleWebSocketRetry(5000);
      };

      this.wsClient.onerror = (err) => {
        this.log.error(`WebSocket error: ${describeError(err)}`);
      };

      this.log.info('WebSocket connection established.');

      if (this.wsConsecutiveFailures > 0) {
        this.log.info('WebSocket connection recovered; stopping polling fallback.');
      }
      this.wsConsecutiveFailures = 0;
      if (this.timerHandle) {
        clearTimeout(this.timerHandle);
        this.timerHandle = undefined;
      }

      if (this.wsRefreshHandle) {
        clearTimeout(this.wsRefreshHandle);
      }
      this.wsRefreshHandle = setTimeout(
        () => {
          this.log.debug('Proactively refreshing WebSocket session before it expires...');
          // Purposefully expire authopts to force a token refresh.
          this.authOpts.expires = +new Date() - 1;
          this.setupWebSocket();
        },
        WS_REFRESH_INTERVAL_MS + WS_REFRESH_JITTER_MS * Math.random()
      );
    } catch (err) {
      if (this.isShuttingDown) {
        return;
      }
      if (String(err).includes('status=403')) {
        this.log.info('WebSocket token fetch returned 403, forcing re-authentication...');
        this.authOpts.expires = +new Date() - 1;
        this.scheduleWebSocketRetry(5000);
      } else {
        this.log.error(`WebSocket setup failed: ${describeError(err)}`);
        this.scheduleWebSocketRetry(30000);
      }
    }
  }

  private scheduleWebSocketRetry(delayMs: number): void {
    this.wsConsecutiveFailures++;

    if (this.wsConsecutiveFailures >= WS_MAX_CONSECUTIVE_FAILURES) {
      if (!this.timerHandle) {
        this.log.warn(
          `WebSocket connection failed ${this.wsConsecutiveFailures} times in a row; falling back to polling every ${this.pollTimeoutSeconds}s until it recovers.`
        );
        this.timerLoop();
      }
      this.log.info(`Retrying WebSocket connection in ${WS_REFRESH_INTERVAL_MS / 1000}s...`);
      setTimeout(() => this.setupWebSocket(), WS_REFRESH_INTERVAL_MS);
    } else {
      this.log.info(`Retrying WebSocket connection in ${delayMs / 1000}s...`);
      setTimeout(() => this.setupWebSocket(), delayMs);
    }
  }

  private async refreshDeviceFromWebSocket(event: WebSocketEvent, authOpts: AuthOpts): Promise<void> {
    try {
      const deviceId = String(`${event.UnitId}-${event.DeviceId}`);
      const matchesId = (id: string) => id === deviceId || id.endsWith('/' + deviceId);

      const accessory = this.accessories.find((a) => matchesId(a.context.accID));
      if (!accessory) {
        this.log.warn(`WebSocket: no device matched DeviceId ${event.DeviceId}, falling back to full refresh`);
        if (this.unmatchedDeviceRefreshHandle) {
          clearTimeout(this.unmatchedDeviceRefreshHandle);
        }
        this.unmatchedDeviceRefreshHandle = setTimeout(() => {
          this.unmatchedDeviceRefreshHandle = undefined;
          this.refreshDevices();
        }, POLL_TIMEOUT_SECS * 1000);
        return;
      }

      const EventType: WebSocketEventTypes = event.EventType;

      if (isLock(accessory)) {
        if (LOCK_EVENT_TYPES.has(EventType)) {
          this.lockHandler.statFromWebSocket(accessory, EventType === WebSocketEventTypes.DoorLocked);
        } else {
          this.log.debug(`WebSocket: unknown lock event type ${EventType} for ${accessory.context.name}`);
        }
      } else if (isSensor(accessory)) {
        if (SENSOR_EVENT_TYPES.has(EventType)) {
          const handled = this.sensorHandler.statFromWebSocket(accessory, EventType);
          if (!handled) {
            const [sensor] = await getSensors([accessory.context.accID], authOpts);
            if (sensor) setTimeout(() => this.sensorHandler.refresh(sensor), POLL_TIMEOUT_SECS * 1000);
            this.log.debug(
              `WebSocket: unable to directly stat sensor event type ${EventType}. Falling back to refresh.`
            );
          }
        } else {
          this.log.debug(`WebSocket: unknown sensor event type ${EventType} for ${accessory.context.name}`);
        }
      } else if (isPartition(accessory)) {
        if (PARTITION_EVENT_TYPES.has(EventType)) {
          const handled = this.partitionHandler.statFromWebSocket(accessory, EventType);
          if (!handled) {
            const [partition] = await getPartitions([accessory.context.accID], authOpts);
            if (partition) setTimeout(() => this.partitionHandler.refresh(partition), POLL_TIMEOUT_SECS * 1000);
            this.log.debug(`WebSocket: falling back to refresh for partition event ${EventType}`);
          }
        } else {
          this.log.debug(`WebSocket: unknown partition event type ${EventType} for ${accessory.context.name}`);
        }
      } else if (isLight(accessory)) {
        if (LIGHT_EVENT_TYPES.has(EventType)) {
          this.lightHandler.statFromWebSocket(accessory, event);
        } else {
          this.log.debug(`WebSocket: unknown light event type ${EventType} for ${accessory.context.name}`);
        }
      } else if (isGarage(accessory)) {
        if (GARAGE_EVENT_TYPES.has(EventType)) {
          this.garageHandler.statFromWebSocket(accessory, EventType);
        } else {
          this.log.debug(`WebSocket: unknown garage event type ${EventType} for ${accessory.context.name}`);
        }
      } else if (isThermostat(accessory)) {
        if (THERMOSTAT_EVENT_TYPES.has(EventType)) {
          const handled = this.thermostatHandler.statFromWebSocket(accessory, event);
          if (!handled) {
            const [thermostat] = await getThermostats([accessory.context.accID], authOpts);
            if (thermostat) setTimeout(() => this.thermostatHandler.refresh(thermostat), POLL_TIMEOUT_SECS * 1000);
          }
        } else {
          this.log.debug(`WebSocket: unknown thermostat event type ${EventType} for ${accessory.context.name}`);
        }
      } else if (isDoorbell(accessory)) {
        if (CAMERA_EVENT_TYPES.has(EventType)) {
          this.doorbellHandler.statFromWebSocket(accessory, EventType);
        } else {
          this.log.debug(`WebSocket: unknown doorbell event type ${EventType} for ${accessory.context.name}`);
        }
      } else {
        this.log.info(`Received a WS event for an unknown device type. Ignoring`);
        this.log.debug(`Unknown WS event:`, event);
      }
    } catch (err) {
      this.log.error(`refreshDevice error: ${err}`);
    }
  }

  configureAccessory(accessory: PlatformAccessory) {
    if (accessory.context['sensorType']) {
      if (!accessory.context['type']) {
        this.log.debug(`Refusing to restore ${accessory.displayName} from cache`);
        this.accessoriesToUpdate.push(accessory as PlatformAccessory<BaseContext>);
        return;
      }
    }

    if (isPartition(accessory)) {
      this.partitionHandler.setup(accessory);
    } else if (isSensor(accessory)) {
      this.sensorHandler.setup(accessory);
    } else if (isLight(accessory)) {
      this.lightHandler.setup(accessory);
    } else if (isLock(accessory)) {
      this.lockHandler.setup(accessory);
    } else if (isGarage(accessory)) {
      this.garageHandler.setup(accessory);
    } else if (isThermostat(accessory)) {
      this.thermostatHandler.setup(accessory);
    } else if (isDoorbell(accessory)) {
      this.doorbellHandler.setup(accessory);
    } else {
      this.log.warn(`Unrecognized accessory ${accessory.context['accID']} loaded from cache`);
    }

    this.accessories.push(accessory as PlatformAccessory<BaseContext>);
    this.log.info(`Loaded from cache: ${accessory.context['name']} (${accessory.context['accID']})`);
  }

  // Internal Methods //////////////////////////////////////////////////////////

  async loginSession(): Promise<AuthOpts> {
    const now = +new Date();
    if (now > this.authOpts.expires) {
      this.log.debug(`Logging into Alarm.com as ${this.username}`);
      await login(this.username, this.password, this.useMFA ? this.mfaToken : undefined)
        .then((authOpts) => {
          authOpts.expires = +new Date() + 1000 * 60 * this.authTimeoutMinutes;
          this.authOpts = authOpts;
          this.log.debug(`Logged into Alarm.com as ${this.username}`);
        })
        .catch((err) => {
          this.log.error(`loginSession Error: ${err.message}`);
          this.log.info('Refreshing session authentication.');
          this.authOpts.expires = +new Date() - 1000 * 60 * this.authTimeoutMinutes;
        });
    }
    return this.authOpts;
  }

  async listDevices(): Promise<SimplifiedSystemState> {
    const res = await this.loginSession();
    const systemStates = await fetchStateForAllSystems(res);
    return systemStates.reduce(
      (out, system) => {
        out.partitions = out.partitions.concat(system.partitions);
        out.sensors = out.sensors.concat(system.sensors);
        out.lights = out.lights.concat(system.lights);
        out.locks = out.locks.concat(system.locks);
        out.garages = out.garages.concat(system.garages);
        out.thermostats = out.thermostats.concat(system.thermostats);
        out.cameras = out.cameras.concat(system.cameras);
        return out;
      },
      {
        partitions: [] as PartitionState[],
        sensors: [] as SensorState[],
        lights: [] as LightState[],
        locks: [] as LockState[],
        garages: [] as GarageState[],
        thermostats: [] as ThermostatState[],
        cameras: [] as CameraState[]
      }
    );
  }

  async getAccountSettings() {
    try {
      const authOpts = await this.loginSession();
      const identities = await getIdentitiesState(authOpts.cookie, authOpts.ajaxKey);
      const identity = identities.data[0];
      if (identity) {
        this.tempDisplayUnitSetting = identity.attributes.localizeTempUnitsToCelsius
          ? this.api.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
          : this.api.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
      }
    } catch (e) {
      this.log.error(
        `There was an error retrieving account settings. Please check that your credentials are correct and restart the plugin.`
      );
      if (typeof e === 'string') {
        this.log.error(e);
      } else if (e instanceof Error) {
        this.log.error(e.message);
      }
    }
  }

  async refreshDevices(): Promise<void> {
    await this.getAccountSettings();

    await this.loginSession()
      .then((res) => fetchStateForAllSystems(res))
      .then((systemStates) => {
        if (this.log.logLevel > 3) {
          this.writePayload(this.api.user.storagePath() + '/', 'ADC-SystemStates.json', JSON.stringify(systemStates));
        }

        systemStates.forEach((system) => {
          if (system.partitions) {
            system.partitions.forEach((p) => this.partitionHandler.refresh(p));
          } else {
            throw new Error('No partitions found, check configuration with security system provider');
          }

          if (system.sensors) {
            system.sensors.forEach((s) => this.sensorHandler.refresh(s));
          } else {
            this.log.info('No sensors found, ignore if expected, or check configuration with security system provider');
          }

          if (system.lights) {
            system.lights.forEach((l) => this.lightHandler.refresh(l));
          } else {
            this.log.info('No lights found, ignore if expected, or check configuration with security system provider');
          }

          if (system.locks) {
            system.locks.forEach((l) => this.lockHandler.refresh(l));
          } else {
            this.log.info('No locks found, ignore if expected, or check configuration with security system provider');
          }

          if (system.garages) {
            system.garages.forEach((g) => this.garageHandler.refresh(g));
          } else {
            this.log.info(
              'No garage doors found, ignore if expected, or check configuration with security system provider'
            );
          }

          if (system.thermostats) {
            system.thermostats.forEach((t) => this.thermostatHandler.refresh(t));
          } else {
            this.log.info(
              'No thermostats found, ignore if expected, or check configuration with security system provider'
            );
          }

          if (system.cameras) {
            system.cameras.forEach((c) => this.doorbellHandler.refresh(c as CameraState));
          } else {
            this.log.info('No cameras found, ignore if expected, or check configuration with security system provider');
          }
        });
      })
      .catch((err) => {
        this.log.error(`refreshDevices Error: ${err.message}`);
        this.log.info('Refreshing session authentication.');
        this.authOpts.expires = +new Date() - 1000 * 60 * this.authTimeoutMinutes;
      });
  }

  // Accessory Methods /////////////////////////////////////////////////////////

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addAccessory(accessory: PlatformAccessory<BaseContext>, type: any, model: string): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;

    // Check before mutating — the previous push-then-findIndex path always hit
    // the register branch and never the "prevent existing" warning.
    if (this.accessories.some((existing) => existing.context.accID === id)) {
      this.log.warn(`Preventing adding existing ${model} ${name} with id ${id}`);
      return;
    }

    this.accessories.push(accessory);
    const serviceUUID = this.api.hap.uuid.generate(id + type);
    accessory.addService(type, name, serviceUUID);
    this.api.registerPlatformAccessories(PLUGIN_ID, PLUGIN_NAME, [accessory]);
  }

  removeAccessory(accessory?: PlatformAccessory<BaseContext>): void {
    if (!accessory) {
      return;
    }

    this.log.info(`Removing ${accessory.context.name} (${accessory.context.accID}) from HomeBridge`);
    this.api.unregisterPlatformAccessories(PLUGIN_ID, PLUGIN_NAME, [accessory]);
    this.accessories.splice(this.accessories.indexOf(accessory), 1);
  }

  removeAccessories(): void {
    [...this.accessories].forEach((accessory) => this.removeAccessory(accessory));
  }

  writePayload(payloadLogPath: string, payloadLogName: string, payload: string): void {
    const now = new Date();
    const formattedDateTime = now.toLocaleString();
    const name = this.config.name;
    const prefix = '[' + formattedDateTime + '] [' + name + '] ';

    fs.mkdir(
      path.dirname(payloadLogPath),
      {
        recursive: true
      },
      (err) => {
        if (err) {
          this.log.error(prefix + err);
        } else {
          fs.writeFile(
            payloadLogPath + payloadLogName,
            payload,
            {
              flag: 'w+'
            },
            (err) => {
              if (err) {
                this.log.error(prefix + err);
              } else {
                this.log.debug(prefix + payloadLogPath + payloadLogName + ' written');
              }
            }
          );
        }
      }
    );
  }
}

function fetchStateForAllSystems(res: AuthOpts): Promise<FlattenedSystemState[]> {
  return Promise.all(res.systems.map((id: string) => getCurrentState(id, res)));
}
