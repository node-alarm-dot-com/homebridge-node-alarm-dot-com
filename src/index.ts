import {
  API,
  APIEvent,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP,
  Logger,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig
} from 'homebridge';

import fs from 'fs';

import {
  GARAGE_STATES,
  LIGHT_STATES,
  LOCK_STATES,
  SENSOR_STATES,
  SYSTEM_STATES,
  THERMOSTAT_STATES
} from 'node-alarm-dot-com/dist/_models/States';

import path from 'path';

import {
  armAway,
  armStay,
  AuthOpts,
  closeGarage,
  DeviceState,
  disarm,
  FlattenedSystemState,
  GarageState,
  getCurrentState,
  getIdentitiesState,
  LightState,
  LockState,
  login,
  openGarage,
  PartitionActionOptions,
  SensorState,
  SensorType,
  setLightOff,
  setLightOn,
  setLockSecure,
  setLockUnsecure,
  setThermostatState,
  setThermostatTargetCoolTemperature,
  setThermostatTargetHeatTemperature,
  ThermostatState
} from 'node-alarm-dot-com';

import {
  BaseContext,
  GarageContext,
  isGarage,
  isLight,
  isLock,
  isPartition,
  isSensor,
  isThermostat,
  LightContext,
  LockContext,
  PartitionContext,
  SensorContext,
  ThermostatContext
} from './_models/Contexts';
import { SimplifiedSystemState } from './_models/SimplifiedSystemState';
import { CustomLogger, CustomLogLevel } from './CustomLogger';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
let hap: HAP;
const PLUGIN_ID = 'homebridge-node-alarm-dot-com';
const PLUGIN_NAME = 'Alarmdotcom';
const MANUFACTURER = 'Alarm.com';
const AUTH_TIMEOUT_MINS = 10; // default for session authentication refresh
const POLL_TIMEOUT_SECS = 60; // default for device state polling
const LOG_LEVEL = CustomLogLevel.NOTICE; // default for log entries: 0 = NONE, 1 = ERROR, 2 = WARN, 3 = NOTICE, 4 = VERBOSE

let platformAccessory: typeof PlatformAccessory;
let hapService: HAP['Service'];
let hapCharacteristic: HAP['Characteristic'];
let uuidGen: typeof import('hap-nodejs/dist/lib/util/uuid');

export = (api: API): void => {
  hap = api.hap;
  platformAccessory = api.platformAccessory;
  hapService = api.hap.Service;
  hapCharacteristic = api.hap.Characteristic;
  uuidGen = api.hap.uuid;

  api.registerPlatform(PLUGIN_ID, PLUGIN_NAME, ADCPlatform);
};

class ADCPlatform implements DynamicPlatformPlugin {
  public readonly log: CustomLogger;
  public readonly api: API;
  /**
   * Used to keep track of restored, cached accessories
   * @private
   */
  private readonly accessories: PlatformAccessory[] = [];
  private readonly accessoriesToUpdate: PlatformAccessory[] = [];
  private authOpts: AuthOpts;
  private config: PlatformConfig;
  private logLevel: CustomLogLevel;
  private armingModes: Record<string, Record<string, boolean>>;
  private ignoredDevices: string[];
  private useMFA: boolean;
  private mfaToken?: string;
  private tempDisplayUnitSetting: number;

  /**
   * The platform class constructor used when registering a plugin.
   *
   * @param log  The platform's logging function.
   * @param config  The platform's config.json section as object.
   * @param api  The homebridge API.
   */
  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.api = api;
    this.config = config ?? { platform: PLUGIN_NAME };
    this.logLevel = this.config.logLevel ?? LOG_LEVEL;
    this.log = new CustomLogger(log, this.logLevel);
    this.ignoredDevices = this.config.ignoredDevices ?? [];
    this.useMFA = this.config.useMFA ?? false;
    this.mfaToken = this.config.useMFA ? this.config.mfaCookie : null;
    this.tempDisplayUnitSetting = hapCharacteristic.TemperatureDisplayUnits.CELSIUS;

    this.config.authTimeoutMinutes = this.config.authTimeoutMinutes ?? AUTH_TIMEOUT_MINS;
    this.config.pollTimeoutSeconds = this.config.pollTimeoutSeconds ?? POLL_TIMEOUT_SECS;

    this.authOpts = {
      expires: +new Date() - 1
    } as AuthOpts;

    // Default arming mode options
    this.armingModes = {
      away: {
        nightArming: false,
        noEntryDelay: false,
        silentArming: false
      },
      night: {
        nightArming: true,
        noEntryDelay: false,
        silentArming: true
      },
      stay: {
        nightArming: false,
        noEntryDelay: false,
        silentArming: true
      }
    };

    // Overwrite default arming modes with config settings.
    if (this.config.armingModes !== undefined) {
      for (const key in this.config.armingModes) {
        this.armingModes[key].nightArming = Boolean(this.config.armingModes[key].nightArming);
        this.armingModes[key].noEntryDelay = Boolean(this.config.armingModes[key].noEntryDelay);
        this.armingModes[key].silentArming = Boolean(this.config.armingModes[key].silentArming);
      }
    }

    // Finally, check to see if the homebridge api is available and that the
    // necessary config variables are present
    if (!api && !config) {
      return;
    } else {
      this.api = api;

      if (!this.config.username) {
        this.log.error(MANUFACTURER + ': Missing required username in config');
        return;
      }
      if (!this.config.password) {
        this.log.error(MANUFACTURER + ': Missing required password in config');
        return;
      }

      this.api.on(APIEvent.DID_FINISH_LAUNCHING, this.registerAlarmSystem.bind(this));
    }
  }

  // List and Add Devices //////////////////////////////////////////////////////

  /**
   * When the homebridge api finally registers the plugin, homebridge fires the
   * didFinishLaunching event, which in turn, launches the following
   * registerAlarmSystem method
   */
  async registerAlarmSystem() {
    // First, let's unregister any restored devices the user wants to be ignored
    this.accessories.forEach((accessory) => {
      // If the device is ignored, we want to stop the restore
      const ignored = this.ignoredDevices.indexOf(accessory.context.accID) > -1;
      if (ignored) {
        this.log.debug(`Removing ignored device ${accessory.context.accID} from homebridge`);
        // Remove the accessory from HomeBridge
        this.removeAccessory(accessory);
      }
    });

    // We also want to unregister any accessories which need upgrading so they will be re-added on the next pull
    this.accessoriesToUpdate.forEach((accessory) => {
      this.removeAccessory(accessory);
    });

    // Retrieve global account information.
    await this.getAccountSettings();

    this.listDevices()
      .then((res) => {
        this.log.debug('Registering system:');
        this.log.debug(JSON.stringify(res));

        for (const device in res) {
          if (device === 'partitions' && typeof res[device][0] === 'undefined') {
            // Debug log if no partition. This can happen when someone doesn't have monitoring.
            this.log.debug(`Received no partitions from Alarm.com.`);
          } else if (res[device].length > 0) {
            this.log.info(`Received ${res[device].length} ${device} from Alarm.com`);

            res[device].forEach((d: DeviceState) => {
              const deviceType = d.type;
              const realDeviceType = deviceType.split('/')[1];
              // Check so we don't add accessories which were already restored
              // Don't add devices which should be ignored
              if (!this.ignoredDevices.includes(d.id)) {
                const uuid = this.api.hap.uuid.generate(d.id);
                const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);
                if (!existingAccessory) {
                  if (realDeviceType === 'partition') {
                    this.addPartition(d);
                  } else if (realDeviceType === 'sensor') {
                    this.addSensor(d as SensorState);
                  } else if (realDeviceType === 'light') {
                    this.addLight(d as LightState);
                  } else if (realDeviceType === 'lock') {
                    this.addLock(d as LockState);
                  } else if (realDeviceType === 'garage-door') {
                    this.addGarage(d as GarageState);
                  } else if (realDeviceType === 'thermostat') {
                    this.addThermostat(d as ThermostatState);
                  }
                  // add more devices here as available, ie. garage doors, etc

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

    // Start a timer to periodically refresh status
    this.timerLoop();
  }

  /**
   * Create a randomized timer to refresh device state
   */
  timerLoop() {
    // Create a randomized delay by adding between 0 - 30 seconds to timer
    const timerDelay = this.config.pollTimeoutSeconds * 1000 + 30000 * Math.random();
    setTimeout(() => {
      this.refreshDevices();
      this.timerLoop();
    }, timerDelay);
  }

  /**
   * REQUIRED: This method is called by homebridge to instantiate the accessory
   * from the accessory cache.
   *
   * @param {object} accessory  The accessory in question.
   */
  configureAccessory(accessory: PlatformAccessory) {
    // Don't restore sensor if it's pre-1.8.1 as it needs upgrading.
    if (accessory.context.sensorType) {
      if (!accessory.context.type) {
        this.log.debug(`Refusing to restore ${accessory.displayName} from cache`);
        this.accessoriesToUpdate.push(accessory);
        return;
      }
    }

    if (isPartition(accessory)) {
      this.setupPartition(accessory);
    } else if (isSensor(accessory)) {
      this.setupSensor(accessory);
    } else if (isLight(accessory)) {
      this.setupLight(accessory);
    } else if (isLock(accessory)) {
      this.setupLock(accessory);
    } else if (isGarage(accessory)) {
      this.setupGarage(accessory);
    } else if (isThermostat(accessory)) {
      this.setupThermostat(accessory);
    } else {
      this.log.warn(`Unrecognized accessory ${accessory.context.accID} loaded from cache`);
    }

    this.accessories.push(accessory);
    this.log.info(`Loaded from cache: ${accessory.context.name} (${accessory.context.accID})`);
  }

  // Internal Methods //////////////////////////////////////////////////////////

  /**
   * Method to retrieve/store/maintain login session state for the account.
   */
  async loginSession(): Promise<AuthOpts> {
    const now = +new Date();
    if (now > this.authOpts.expires) {
      this.log.debug(`Logging into Alarm.com as ${this.config.username}`);
      //const authOpts = await login(this.config.username, this.config.password, this.mfaToken);
      await login(this.config.username, this.config.password, this.useMFA ? this.mfaToken : null)
        .then((authOpts) => {
          // Cache login response and estimated expiration time
          authOpts.expires = +new Date() + 1000 * 60 * this.config.authTimeoutMinutes;
          this.authOpts = authOpts;
          this.log.debug(`Logged into Alarm.com as ${this.config.username}`);
        })
        .catch((err) => {
          this.log.error(`loginSession Error: ${err.message}`);
          this.log.info('Refreshing session authentication.');
          this.authOpts.expires = +new Date() - 1000 * 60 * this.config.authTimeoutMinutes; // set to the past to trigger refresh
        });
    }
    return this.authOpts;
  }

  /**
   * Method to gather devices and transform into a usable object.
   */
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
        return out;
      },
      {
        partitions: [],
        sensors: [],
        lights: [],
        locks: [],
        garages: [],
        thermostats: []
      }
    );
  }

  /**
   * This method makes a call to alarm.com in order to retrieve global account information.
   */
  async getAccountSettings() {
    try {
      const authOpts = await this.loginSession();
      const identities = await getIdentitiesState(authOpts.cookie, authOpts.ajaxKey);
      const identity = identities.data[0];
      if (identity) {
        this.tempDisplayUnitSetting = identity.attributes.localizeTempUnitsToCelsius
          ? hapCharacteristic.TemperatureDisplayUnits.CELSIUS
          : hapCharacteristic.TemperatureDisplayUnits.FAHRENHEIT;
      }
    } catch (e) {
      this.log.error(
        `There was an error retrieving account settings. Please check that your credentials are correct and restart the plugin.`
      );
      if (typeof e === typeof String) {
        this.log.error(e);
      } else if (e instanceof Error) {
        this.log.error(e.message);
      }
    }
  }

  /**
   * Method to update state on accessories/devices.
   */
  async refreshDevices(): Promise<void> {
    // Get latest account settings, notably C/F display setting
    await this.getAccountSettings();

    await this.loginSession()
      .then((res) => fetchStateForAllSystems(res))
      .then((systemStates) => {
        // writes systemStates payload to a file for debug/troubleshooting
        if (this.logLevel > 3) {
          this.writePayload(this.api.user.storagePath() + '/', 'ADC-SystemStates.json', JSON.stringify(systemStates));
        }

        // break dist system components
        systemStates.forEach((system) => {
          if (system.partitions) {
            system.partitions.forEach((partition) => {
              const accessory = this.accessories.find(
                (accessory) => accessory.context.accID === partition.id
              ) as PlatformAccessory<PartitionContext>;
              // Don't do anything if the device is ignored
              if (!this.ignoredDevices.includes(partition.id)) {
                // If this is a new device, add it to the system
                if (!accessory) {
                  return this.addPartition(partition);
                }
                // Get the current device state
                this.statPartitionState(accessory, partition);
              }
            });
          } else {
            // fatal error, we require partitions and cannot continue
            throw new Error('No partitions found, check configuration with security system provider');
          }

          if (system.sensors) {
            system.sensors.forEach((sensor) => {
              const accessory = this.accessories.find(
                (accessory) => accessory.context.accID === sensor.id
              ) as PlatformAccessory<SensorContext>;
              if (!this.ignoredDevices.includes(sensor.id)) {
                if (!accessory) {
                  return this.addSensor(sensor);
                }
                this.statSensorState(accessory, sensor);
              }
            });
          } else {
            this.log.info('No sensors found, ignore if expected, or check configuration with security system provider');
          }

          if (system.lights) {
            system.lights.forEach((light) => {
              const accessory = this.accessories.find(
                (accessory) => accessory.context.accID === light.id
              ) as PlatformAccessory<LightContext>;
              if (!this.ignoredDevices.includes(light.id)) {
                if (!accessory) {
                  return this.addLight(light);
                }
                this.statLightState(accessory, light, null);
              }
            });
          } else {
            this.log.info('No lights found, ignore if expected, or check configuration with security system provider');
          }

          if (system.locks) {
            system.locks.forEach((lock) => {
              const accessory = this.accessories.find(
                (accessory) => accessory.context.accID === lock.id
              ) as PlatformAccessory<LockContext>;
              if (!this.ignoredDevices.includes(lock.id)) {
                if (!accessory) {
                  return this.addLock(lock);
                }
                this.statLockState(accessory, lock);
              }
            });
          } else {
            this.log.info('No locks found, ignore if expected, or check configuration with security system provider');
          }

          if (system.garages) {
            system.garages.forEach((garage) => {
              const accessory = this.accessories.find(
                (accessory) => accessory.context.accID === garage.id
              ) as PlatformAccessory<GarageContext>;
              if (!this.ignoredDevices.includes(garage.id)) {
                if (!accessory) {
                  return this.addGarage(garage);
                }
                this.statGarageState(accessory, garage);
              }
            });
          } else {
            this.log.info(
              'No garage doors found, ignore if expected, or check configuration with security system provider'
            );
          }

          if (system.thermostats) {
            system.thermostats.forEach((thermostat) => {
              const accessory = this.accessories.find(
                (accessory) => accessory.context.accID === thermostat.id
              ) as PlatformAccessory<ThermostatContext>;
              if (!this.ignoredDevices.includes(thermostat.id)) {
                if (!accessory) {
                  return this.addThermostat(thermostat);
                }
                this.statThermostatState(accessory, thermostat);
              }
            });
          } else {
            this.log.info(
              'No thermostats found, ignore if expected, or check configuration with security system provider'
            );
          }
        });
      })
      .catch((err) => {
        this.log.error(`refreshDevices Error: ${err.message}`);
        this.log.info('Refreshing session authentication.');
        this.authOpts.expires = +new Date() - 1000 * 60 * this.config.authTimeoutMinutes; // set to the past to trigger refresh
      });
  }

  // Partition Methods /////////////////////////////////////////////////////////

  /**
   * Adds necessary parameters of the alarm panel for homebridge before passing
   * it to further setup methods.
   *
   * @param {Object} partition  Passed in partition object from Alarm.com
   */
  addPartition(partition): void {
    const id = partition.id;
    let accessory = this.accessories.find(
      (accessory) => accessory.context.accID === id
    ) as PlatformAccessory<PartitionContext>;
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const name = partition.attributes.description;
    const uuid = uuidGen.generate(id);
    accessory = new platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: null,
      desiredState: null,
      statusFault: null,
      partitionType: 'default'
    };

    this.log.info(`Adding partition ${name} (id=${id}, uuid=${uuid})`);

    this.addAccessory(accessory, hapService.SecuritySystem, 'Security Panel');

    this.setupPartition(accessory);

    // Set the initial partition state
    this.statPartitionState(accessory, partition);
  }

  /**
   * Tells homebridge there is an alarm panel, exposing it's capabilities and
   * state.
   *
   * @param accessory  The accessory representing the alarm panel.
   */
  setupPartition(accessory: PlatformAccessory<PartitionContext>): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = 'Security Panel';

    // Setup HomeKit accessory information
    accessory
      .getService(hapService.AccessoryInformation)
      .setCharacteristic(hapCharacteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hapCharacteristic.Model, model)
      .setCharacteristic(hapCharacteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on('identify', () => {
      this.log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(hapService.SecuritySystem);

    service
      .getCharacteristic(hapCharacteristic.SecuritySystemCurrentState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.state));

    service
      .getCharacteristic(hapCharacteristic.SecuritySystemTargetState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changePartitionState(accessory, value, callback)
      );

    service
      .getCharacteristic(hapCharacteristic.StatusFault)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.statusFault));
  }

  /**
   * Reports on the state of the alarm panel.
   *
   * @param accessory  The accessory representing the alarm panel.
   * @param partition  The alarm panel parameters from Alarm.com.
   */
  statPartitionState(accessory: PlatformAccessory<PartitionContext>, partition): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getPartitionState(partition.attributes.state);
    const desiredState = getPartitionState(partition.attributes.desiredState);
    const statusFault = Boolean(partition.attributes.needsClearIssuesPrompt);

    if (state !== accessory.context.state) {
      this.log.debug(`Updating partition ${name} (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;
      accessory
        .getService(hapService.SecuritySystem)
        .getCharacteristic(hapCharacteristic.SecuritySystemCurrentState)
        .updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      this.log.info(
        `Updating partition ${name} (${id}), desiredState=${desiredState}, prev=${accessory.context.desiredState}`
      );

      accessory.context.desiredState = desiredState;
      accessory
        .getService(hapService.SecuritySystem)
        .getCharacteristic(hapCharacteristic.SecuritySystemTargetState)
        .updateValue(desiredState);
    }

    if (statusFault !== accessory.context.statusFault) {
      this.log.info(
        `Updating partition ${name} (${id}), statusFault=${statusFault}, prev=${accessory.context.statusFault}`
      );

      accessory.context.statusFault = statusFault;
      accessory
        .getService(hapService.SecuritySystem)
        .getCharacteristic(hapCharacteristic.StatusFault)
        .updateValue(statusFault);
    }
  }

  /**
   * Changes/sets the state of the alarm panel.
   *
   * @param accessory  The accessory representing the alarm panel.
   * @param value
   * @param callback
   */
  async changePartitionState(
    accessory: PlatformAccessory<PartitionContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const id = accessory.context.accID;
    let method: typeof armAway | typeof armStay | typeof disarm;
    const opts = {} as PartitionActionOptions;

    switch (value) {
      case hapCharacteristic.SecuritySystemTargetState.STAY_ARM:
        method = armStay;
        opts.noEntryDelay = this.armingModes.stay.noEntryDelay;
        opts.silentArming = this.armingModes.stay.silentArming;
        opts.nightArming = this.armingModes.stay.nightArming;
        break;
      case hapCharacteristic.SecuritySystemTargetState.NIGHT_ARM:
        method = armStay;
        opts.noEntryDelay = this.armingModes.night.noEntryDelay;
        opts.silentArming = this.armingModes.night.silentArming;
        opts.nightArming = this.armingModes.night.nightArming;
        break;
      case hapCharacteristic.SecuritySystemTargetState.AWAY_ARM:
        method = armAway;
        opts.noEntryDelay = this.armingModes.away.noEntryDelay;
        opts.silentArming = this.armingModes.away.silentArming;
        opts.nightArming = this.armingModes.away.nightArming;
        break;
      case hapCharacteristic.SecuritySystemTargetState.DISARM:
        method = disarm;
        break;
      default: {
        const msg = `Can't set SecuritySystem to unknown value ${value}`;
        this.log.warn(msg);
        return callback(new Error(msg));
      }
    }

    this.log.info(`changePartitionState(${accessory.context.accID}, ${value})`);

    accessory.context.desiredState = value;

    await this.loginSession()
      .then((res) => method(id, res, opts))
      .then((res) => res.data)
      .then((partition) => this.statPartitionState(accessory, partition))
      .then(() => callback()) // need to determine why we need this
      .catch((err) => {
        this.log.error(`Error: Failed to change partition state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  // Sensor Methods ////////////////////////////////////////////////////////////

  /**
   * Adds necessary parameters to a sensor for homebridge before passing it to
   * further setup methods.
   *
   * @param {Object} sensor  Passed in sensor object from Alarm.com
   */
  addSensor(sensor: SensorState): void {
    const id = sensor.id;
    let accessory = this.accessories.find((a) => a.context.accID === id) as PlatformAccessory<SensorContext>;
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, , model] = getSensorType(sensor);
    if (type === undefined) {
      this.log.warn(
        `Warning: Sensor ${sensor.attributes.description} has unknown state ${sensor.attributes.state} (${sensor.id})`
      );
      return;
    }

    const name = sensor.attributes.description;
    const uuid = uuidGen.generate(id);
    accessory = new platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: null,
      batteryLow: false,
      sensorType: model,
      type: sensor.attributes.deviceType
    };

    // if the sensor id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      this.log.info(`Adding ${model} "${name}" (id=${id}, uuid=${uuid})`);

      this.addAccessory(accessory, type, model);
      this.setupSensor(accessory);

      // Set the initial sensor state
      this.statSensorState(accessory, sensor);
    }
  }

  /**
   * Tells homebridge there is a sensor, exposing its capabilities and state.
   *
   * @param accessory  The accessory representing a sensor
   */
  setupSensor(accessory: PlatformAccessory): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.sensorType;
    const [type, characteristic] = sensorModelToType(model);
    if (!characteristic && this.logLevel > 1) {
      throw new Error(`Unrecognized sensor ${accessory.context.accID}`);
    }

    // Setup HomeKit accessory information
    accessory
      .getService(hapService.AccessoryInformation)
      .setCharacteristic(hapCharacteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hapCharacteristic.Model, model)
      .setCharacteristic(hapCharacteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(type);

    service
      .getCharacteristic(characteristic)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.state));

    service
      .getCharacteristic(hapCharacteristic.StatusLowBattery)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.batteryLow));
  }

  /**
   * Reports on the state of the sensor accessory.
   *
   * @param accessory  The accessory representing a sensor.
   * @param sensor  The sensor parameters from Alarm.com.
   */
  statSensorState(accessory: PlatformAccessory<SensorContext>, sensor: SensorState): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getSensorState(sensor);
    const batteryLow = Boolean(sensor.attributes.lowBattery || sensor.attributes.criticalBattery);
    const [type, characteristic, model] = getSensorType(sensor);

    if (state !== accessory.context.state) {
      this.log.info(`Updating sensor ${name} (${model}) (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;
      accessory.getService(type).getCharacteristic(characteristic).updateValue(state);
    }

    if (batteryLow !== accessory.context.batteryLow) {
      this.log.info(`Updating sensor ${name} (${id}), batteryLow=${batteryLow}, prev=${accessory.context.batteryLow}`);

      accessory.context.batteryLow = batteryLow;
      accessory.getService(type).getCharacteristic(hapCharacteristic.StatusLowBattery).updateValue(batteryLow);
    }
  }

  /* Sensors only report state, no ability to change their state. */

  // Light Methods /////////////////////////////////////////////////////////

  /**
   * Adds necessary parameters to a light for homebridge before passing it to
   * further setup methods.
   *
   * @param {Object} light  Passed in light object from Alarm.com.
   */
  addLight(light: LightState): void {
    const id = light.id;
    let accessory = this.accessories.find(
      (accessory) => accessory.context.accID === id
    ) as PlatformAccessory<LightContext>;
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, model] = [hapService.Lightbulb, 'Light'];

    const name = light.attributes.description;
    const uuid = uuidGen.generate(id);
    accessory = new platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: light.attributes.state,
      desiredState: light.attributes.desiredState,
      isDimmer: light.attributes.isDimmer,
      lightLevel: light.attributes.lightLevel,
      lightType: model
    };

    // if the light id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      this.log.info(
        `Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`
      );

      this.addAccessory(accessory, type, model);
      this.setupLight(accessory);

      // Set the initial light state
      this.statLightState(accessory, light, null);
    }
  }

  /**
   * Tells homebridge there is a light, exposing it's capabilities and state.
   *
   * @param accessory  The accessory representing a light.
   */
  setupLight(accessory: PlatformAccessory<LightContext>): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.lightType;
    const type = hapService.Lightbulb;

    // Setup HomeKit accessory information
    accessory
      .getService(hapService.AccessoryInformation)
      .setCharacteristic(hapCharacteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hapCharacteristic.Model, model)
      .setCharacteristic(hapCharacteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(type);

    service
      .getCharacteristic(hapCharacteristic.On)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.state);
      })
      .on('set', (desiredState: boolean, callback: CharacteristicSetCallback) => {
        this.changeLight(accessory, desiredState, callback);
      });

    if (accessory.context.isDimmer) {
      service
        .getCharacteristic(hapCharacteristic.Brightness)
        .on('get', (callback: CharacteristicGetCallback) => {
          callback(null, accessory.context.lightLevel);
        })
        .on('set', (brightness: number, callback: CharacteristicSetCallback) => {
          this.changeLightBrightness(accessory, brightness, callback);
        });
    }
  }

  /**
   * Reports on the state of the light accessory.
   *
   * @param accessory  The accessory representing the light accessory.
   * @param light  The light accessory parameters from Alarm.com.
   * @param callback
   */
  statLightState(
    accessory: PlatformAccessory<LightContext>,
    light: LightState,
    callback?: CharacteristicSetCallback
  ): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const newState = getLightState(light.attributes.state);
    const newBrightness = light.attributes.lightLevel;

    if (newState !== accessory.context.state) {
      this.log.info(`Updating light ${name} (${id}), state=${newState}, prev=${accessory.context.state}`);

      accessory.context.state = newState;

      accessory.getService(hapService.Lightbulb).updateCharacteristic(hapCharacteristic.On, newState);
    }

    if (accessory.context.isDimmer && newBrightness !== accessory.context.lightLevel) {
      accessory.context.lightLevel = newBrightness;
      accessory.getService(hapService.Lightbulb).updateCharacteristic(hapCharacteristic.Brightness, newBrightness);
    }

    if (callback !== null) {
      callback();
    }
  }

  /**
   * Change the physical state of a light using the Alarm.com API.
   *
   * @param accessory  The light to be changed.
   * @param {number} brightness  The brightness of a light, from 0-100 (only
   *    works with dimmers).
   * @param callback
   */
  async changeLightBrightness(
    accessory: PlatformAccessory<LightContext>,
    brightness: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const id = accessory.context.accID;

    this.log.info(`Changing light (${accessory.context.accID}, light level ${brightness})`);

    accessory.context.lightLevel = brightness;

    await this.loginSession()
      .then((res) => setLightOn(id, res, accessory.context.lightLevel, accessory.context.isDimmer))
      .then((res) => res.data)
      .then((light) => {
        this.statLightState(accessory, light, callback);
      })
      .catch((err) => {
        this.log.error(`Error: Failed to change light state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  /**
   * Change the physical state of a light using the Alarm.com API.
   *
   * @param accessory  The light to be changed.
   * @param {boolean} desiredState  Value representing off or on states of the light.
   * @param callback
   */
  async changeLight(
    accessory: PlatformAccessory<LightContext>,
    desiredState: boolean,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    // Alarm.com expects a single call for both brightness and 'on'
    // We need to ignore the extra call when changing brightness from homekit.
    if (desiredState === accessory.context.state) {
      callback();
      return;
    }

    const id = accessory.context.accID;
    let method: typeof setLightOn | typeof setLightOff;

    if (desiredState === true) {
      method = setLightOn;
    } else {
      method = setLightOff;
    }

    this.log.info(`Changing light (${accessory.context.accID}, ${desiredState})`);

    accessory.context.state = desiredState;

    await this.loginSession()
      .then((res) => method(id, res, accessory.context.lightLevel ?? 100, accessory.context.isDimmer))
      .then((res) => res.data)
      .then((light) => {
        this.statLightState(accessory, light, callback);
      })
      .catch((err) => {
        this.log.error(`Error: Failed to change light state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  // Lock Methods /////////////////////////////////////////////////////////

  /**
   * Adds necessary parameters to a lock for homebridge before passing it to
   * further setup methods.
   *
   * @param {Object} lock  Passed in lock object from Alarm.com.
   */
  addLock(lock: LockState): void {
    const id = lock.id;
    let accessory = this.accessories.find(
      (accessory) => accessory.context.accID === id
    ) as PlatformAccessory<LockContext>;
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, model] = [hapService.LockMechanism, 'Door Lock'];

    const name = lock.attributes.description;
    const uuid = uuidGen.generate(id);
    accessory = new platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: lock.attributes.state,
      desiredState: lock.attributes.desiredState,
      lockType: model
    };

    // if the lock id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      this.log.info(
        `Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`
      );

      this.addAccessory(accessory, type, model);
      this.setupLock(accessory);

      // Set the initial lock state
      this.statLockState(accessory, lock);
    }
  }

  /**
   * Tells homebridge there is a lock, exposing it's capabilities and state.
   *
   * @param accessory  The accessory representing a lock.
   */
  setupLock(accessory: PlatformAccessory<LockContext>): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.lockType;
    const [type, characteristic] = [hapService.LockMechanism, hapCharacteristic.LockCurrentState];
    if (!characteristic && this.logLevel > 1) {
      throw new Error(`Unrecognized lock ${accessory.context.accID}`);
    }

    // Setup HomeKit accessory information
    const homeKitService = accessory.getService(hapService.AccessoryInformation);

    if (homeKitService === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${accessory.context.accID}`);
    }

    homeKitService
      .setCharacteristic(hapCharacteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hapCharacteristic.Model, model)
      .setCharacteristic(hapCharacteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(type);

    if (service === undefined) {
      throw new Error(`Trouble getting service for ${accessory.context.accID}`);
    }

    service.getCharacteristic(hapCharacteristic.LockCurrentState).on('get', (callback: CharacteristicGetCallback) => {
      callback(null, accessory.context.state);
    });

    service
      .getCharacteristic(hapCharacteristic.LockTargetState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeLockState(accessory, value, callback)
      );
  }

  /**
   * Reports on the state of the lock accessory.
   *
   * @param accessory  The accessory representing the lock accessory.
   * @param lock  The lock accessory parameters from Alarm.com.
   */
  statLockState(accessory: PlatformAccessory<LockContext>, lock: LockState): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getLockCurrentState(lock.attributes.state);
    const desiredState = getLockTargetState(lock.attributes.desiredState);
    const service = accessory.getService(hapService.LockMechanism);

    if (service === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${accessory.context.accID}`);
    }

    if (state !== accessory.context.state) {
      this.log.info(`Updating lock ${name} (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;

      service.getCharacteristic(hapCharacteristic.LockCurrentState).updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState;
      service.getCharacteristic(hapCharacteristic.LockTargetState).updateValue(desiredState);
    }
  }

  /**
   * Change the physical state of a lock using the Alarm.com API.
   *
   * @param accessory  The lock to be changed.
   * @param {boolean} value  Value representing locked or unlocked states of the
   *   lock.
   * @param callback
   */
  async changeLockState(
    accessory: PlatformAccessory<LockContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const id = accessory.context.accID;
    let method: typeof setLockSecure | typeof setLockUnsecure;

    switch (value) {
      case hapCharacteristic.LockTargetState.UNSECURED:
        method = setLockUnsecure;
        break;
      case hapCharacteristic.LockTargetState.SECURED:
        method = setLockSecure;
        break;
      default: {
        const msg = `Can't set LockMechanism to unknown value ${value}`;
        this.log.warn(msg);
        return callback(new Error(msg));
      }
    }

    this.log.info(`(un)secureLock)(${accessory.context.accID}, ${value})`);

    accessory.context.desiredState = value;

    await this.loginSession()
      .then((res) => method(id, res))
      .then((res) => res.data)
      .then((lock) => {
        this.statLockState(accessory, lock);
      })
      .then(() => callback())
      .catch((err) => {
        this.log.error(`Error: Failed to change lock state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  // Garage Methods /////////////////////////////////////////////////////////

  addGarage(garage: GarageState): void {
    const id = garage.id;
    let accessory = this.accessories.find(
      (accessory) => accessory.context.accID === id
    ) as PlatformAccessory<GarageContext>;
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, model] = [hapService.GarageDoorOpener, 'Garage Door'];

    const name = garage.attributes.description;
    const uuid = uuidGen.generate(id);
    accessory = new platformAccessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: garage.attributes.state,
      desiredState: garage.attributes.desiredState,
      garageType: model
    };

    // if the garage id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      this.log.info(
        `Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`
      );

      this.addAccessory(accessory, type, model);
      this.setupGarage(accessory);

      // Set the initial garage state
      this.statGarageState(accessory, garage);
    }
  }

  setupGarage(accessory: PlatformAccessory<GarageContext>): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.garageType;
    const [type, characteristic] = [
      hapService.GarageDoorOpener,
      hapCharacteristic.CurrentDoorState,
      hapCharacteristic.TargetDoorState
      // Characteristic.ObstructionDetected
    ];

    if (!characteristic && this.config.logLevel > 1) {
      throw new Error(`Unrecognized garage door opener ${accessory.context.accID}`);
    }

    // Setup HomeKit accessory information
    accessory
      .getService(hapService.AccessoryInformation)
      .setCharacteristic(hapCharacteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hapCharacteristic.Model, model)
      .setCharacteristic(hapCharacteristic.SerialNumber, id);

    // Setup event listeners
    // Todo: (paired, callback) causes troubles
    accessory.on('identify', () => {
      this.log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(type);

    if (service === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${accessory.context.accID}`);
    }

    service.getCharacteristic(hapCharacteristic.CurrentDoorState).on('get', (callback: CharacteristicGetCallback) => {
      callback(null, accessory.context.state);
    });

    service
      .getCharacteristic(hapCharacteristic.TargetDoorState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeGarageState(accessory, value, callback)
      );
  }

  statGarageState(accessory: PlatformAccessory<GarageContext>, garage: GarageState): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getGarageState(garage.attributes.state);
    const desiredState = getGarageState(garage.attributes.desiredState);

    if (state !== accessory.context.state) {
      this.log.info(`Updating garage ${name} (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;

      accessory
        .getService(hapService.GarageDoorOpener)
        .getCharacteristic(hapCharacteristic.CurrentDoorState)
        .updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState;
      accessory
        .getService(hapService.GarageDoorOpener)
        .getCharacteristic(hapCharacteristic.TargetDoorState)
        .updateValue(desiredState);
    }
  }

  /**
   * Change the physical state of a garage using the Alarm.com API.
   *
   * @param accessory  The garage to be changed.
   * @param {boolean} value  Value representing opened or closed states of the
   *   garage.
   * @param callback
   */

  async changeGarageState(
    accessory: PlatformAccessory<GarageContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const id = accessory.context.accID;
    let method: typeof openGarage | typeof closeGarage;

    this.log.debug(String(value));

    switch (value) {
      case hapCharacteristic.TargetDoorState.OPEN:
        method = openGarage;
        break;
      case hapCharacteristic.TargetDoorState.CLOSED:
        method = closeGarage;
        break;
      default: {
        const msg = `Can't set garage to unknown value ${value}`;
        this.log.warn(msg);
        return callback(new Error(msg));
      }
    }

    this.log.info(`Garage Door ${accessory.context.accID}, ${value})`);

    accessory.context.desiredState = value;

    await this.loginSession()
      .then((res) => method(id, res)) // Usually 20-30 seconds
      .then((res) => res.data)
      .then((garage) => {
        this.statGarageState(accessory, garage);
      })
      .then(() => callback())
      .catch((err) => {
        this.log.error(`Error: Failed to change garage state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  // Thermostat Methods /////////////////////////////////////////////////////////

  addThermostat(thermostat: ThermostatState): void {
    const id = thermostat.id;
    let accessory = this.accessories.find(
      (accessory) => accessory.context.accID === id
    ) as PlatformAccessory<ThermostatContext>;
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, model] = [hapService.Thermostat, 'Thermostat'];

    const name = thermostat.attributes.description;
    const uuid = uuidGen.generate(id);
    accessory = new platformAccessory(name, uuid);

    // Homebridge is always in C, if Alarm.com is set to F, convert values to C
    const shouldConvertToC = this.tempDisplayUnitSetting === hapCharacteristic.TemperatureDisplayUnits.FAHRENHEIT;
    const currentTemperature = shouldConvertToC
      ? convertFtoC(thermostat.attributes.ambientTemp)
      : thermostat.attributes.ambientTemp;

    accessory.context = {
      accID: id,
      name: name,
      thermostatType: model,
      state: getThermostatState(thermostat.attributes.state),
      desiredState: getThermostatState(thermostat.attributes.state),
      currentTemperature: currentTemperature,
      targetTemperature: getThermostatTargetTemperature(thermostat, shouldConvertToC),
      supportsHumidity: thermostat.attributes.supportsHumidity,
      humidityLevel: thermostat.attributes.humidityLevel
    };

    // if the thermostat id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      this.log.info(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (current temp: ${currentTemperature})`);

      this.addAccessory(accessory, type, model);
      this.setupThermostat(accessory);

      // Set the initial garage state
      this.statThermostatState(accessory, thermostat);
    }
  }

  setupThermostat(accessory: PlatformAccessory<ThermostatContext>): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.thermostatType;
    const [type, characteristic] = [
      hapService.Thermostat,
      hapCharacteristic.TargetTemperature,
      hapCharacteristic.CurrentTemperature,
      hapCharacteristic.TargetHeatingCoolingState,
      hapCharacteristic.CurrentHeatingCoolingState,
      hapCharacteristic.CurrentRelativeHumidity
    ];

    if (!characteristic && this.config.logLevel > 1) {
      throw new Error(`Unrecognized thermostat ${accessory.context.accID}`);
    }

    // Setup HomeKit accessory information
    accessory
      .getService(hapService.AccessoryInformation)
      .setCharacteristic(hapCharacteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(hapCharacteristic.Model, model)
      .setCharacteristic(hapCharacteristic.SerialNumber, id);

    // Setup event listeners
    // Todo: (paired, callback) causes troubles
    accessory.on('identify', () => {
      this.log.info(`${name} identify requested`);
    });

    const service = accessory.getService(type);

    if (service === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${accessory.context.accID}`);
    }

    service
      .getCharacteristic(hapCharacteristic.CurrentHeatingCoolingState)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.state);
      });

    service
      .getCharacteristic(hapCharacteristic.TargetHeatingCoolingState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue, callback: CharacteristicSetCallback) =>
        this.changeThermostatState(accessory, value, callback)
      );

    service.getCharacteristic(hapCharacteristic.CurrentTemperature).on('get', (callback: CharacteristicGetCallback) => {
      callback(null, accessory.context.currentTemperature);
    });

    service
      .getCharacteristic(hapCharacteristic.TargetTemperature)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.targetTemperature))
      .on('set', (value: number, callback: CharacteristicSetCallback) =>
        this.changeThermostatTargetTemperature(accessory, value, callback)
      );

    if (accessory.context.supportsHumidity) {
      service
        .getCharacteristic(hapCharacteristic.CurrentRelativeHumidity)
        .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.humidityLevel));
    }
  }

  statThermostatState(accessory: PlatformAccessory<ThermostatContext>, thermostat: ThermostatState): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const shouldConvertToC = this.tempDisplayUnitSetting === hapCharacteristic.TemperatureDisplayUnits.FAHRENHEIT;
    const currentTemperature = shouldConvertToC
      ? convertFtoC(thermostat.attributes.ambientTemp)
      : thermostat.attributes.ambientTemp;
    const targetTemperature = getThermostatTargetTemperature(thermostat, shouldConvertToC);
    const currentState = getThermostatState(thermostat.attributes.state);
    const targetState = getThermostatState(thermostat.attributes.desiredState);
    const humidityLevel = thermostat.attributes.humidityLevel;

    if (currentTemperature !== accessory.context.currentTemperature) {
      this.log.info(
        `Updating thermostat ${name} (${id}), ambientTemp=${currentTemperature}, prev=${accessory.context.currentTemperature}`
      );

      accessory.context.currentTemperature = currentTemperature;

      accessory
        .getService(hapService.Thermostat)
        .getCharacteristic(hapCharacteristic.CurrentTemperature)
        .updateValue(currentTemperature);
    }

    if (targetTemperature && targetTemperature !== accessory.context.targetTemperature) {
      this.log.info(
        `Updating thermostat ${name} (${id}), targetTemp=${targetTemperature}, prev=${accessory.context.targetTemperature}`
      );

      accessory.context.targetTemperature = targetTemperature;

      accessory
        .getService(hapService.Thermostat)
        .getCharacteristic(hapCharacteristic.TargetTemperature)
        .updateValue(targetTemperature);
    }

    if (currentState !== accessory.context.state) {
      this.log.info(`Updating thermostat ${name} (${id}), state=${currentState}, prev=${accessory.context.state}`);

      accessory.context.state = currentState;

      accessory
        .getService(hapService.Thermostat)
        .getCharacteristic(hapCharacteristic.CurrentHeatingCoolingState)
        .updateValue(currentState);
    }

    if (targetState !== accessory.context.desiredState) {
      this.log.info(
        `Updating thermostat ${name} (${id}), targetState=${targetState}, prev=${accessory.context.desiredState}`
      );

      accessory.context.desiredState = targetState;

      accessory
        .getService(hapService.Thermostat)
        .getCharacteristic(hapCharacteristic.TargetHeatingCoolingState)
        .updateValue(targetState);
    }

    if (accessory.context.supportsHumidity && humidityLevel !== accessory.context.humidityLevel) {
      this.log.info(`Updating thermostat ${name} (${id}), humidity=${humidityLevel}, prev=${accessory.context.state}`);

      accessory.context.humidityLevel = humidityLevel;

      accessory
        .getService(hapService.Thermostat)
        .getCharacteristic(hapCharacteristic.CurrentRelativeHumidity)
        .updateValue(humidityLevel);
    }
  }

  /**
   * Change the physical state of a thermostat using the Alarm.com API.
   *
   * @param accessory  The thermostat to be changed.
   * @param {boolean} value  Value representing thermostat state.
   * @param callback
   */

  async changeThermostatState(
    accessory: PlatformAccessory<ThermostatContext>,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const id = accessory.context.accID;

    this.log.info(`Thermostat ${accessory.context.accID}, state change: ${value}`);

    accessory.context.desiredState = value;

    let newState;
    switch (value) {
      case hapCharacteristic.CurrentHeatingCoolingState.HEAT:
        newState = THERMOSTAT_STATES.HEATING;
        break;
      case hapCharacteristic.CurrentHeatingCoolingState.COOL:
        newState = THERMOSTAT_STATES.COOLING;
        break;
      case hapCharacteristic.CurrentHeatingCoolingState.OFF:
        newState = THERMOSTAT_STATES.OFF;
        break;
    }

    await this.loginSession()
      .then((res) => setThermostatState(id, newState, res)) // Usually 20-30 seconds
      .then((res) => res.data)
      .then((thermostat) => {
        this.statThermostatState(accessory, thermostat);
      })
      .then(() => callback())
      .catch((err) => {
        this.log.error(`Error: Failed to change thermostat state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  async changeThermostatTargetTemperature(
    accessory: PlatformAccessory<ThermostatContext>,
    value: number,
    callback: CharacteristicSetCallback
  ): Promise<void> {
    const id = accessory.context.accID;
    let method: typeof setThermostatTargetHeatTemperature | typeof setThermostatTargetCoolTemperature;

    switch (accessory.context.state) {
      case hapCharacteristic.CurrentHeatingCoolingState.HEAT:
        method = setThermostatTargetHeatTemperature;
        break;
      case hapCharacteristic.CurrentHeatingCoolingState.COOL:
        method = setThermostatTargetCoolTemperature;
        break;
      default: {
        const msg = `Can't set temperature when in unknown state ${accessory.context.state}`;
        this.log.error(msg);
        return callback(new Error(msg));
      }
    }

    this.log.info(`Thermostat ${accessory.context.accID}, temp change: ${value}`);

    accessory.context.targetTemperature = value;

    if (this.tempDisplayUnitSetting === hapCharacteristic.TemperatureDisplayUnits.FAHRENHEIT) {
      // Homebridge is always in C, if Alarm.com is set to F, convert to F before sending
      value = convertCtoF(value);
    }

    await this.loginSession()
      .then((res) => method(id, value, res)) // Usually 20-30 seconds
      .then((res) => res.data)
      .then((thermostat) => {
        this.statThermostatState(accessory, thermostat);
      })
      .then(() => callback())
      .catch((err) => {
        this.log.error(`Error: Failed to change thermostat state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  // Accessory Methods /////////////////////////////////////////////////////////

  /**
   * Adds accessories to the platform, homebridge and HomeKit.
   *
   * @param accessory  The accessory to be added from the platform.
   * @param type  The type of accessory.
   * @param model  The model of the accessory.
   */
  addAccessory(accessory: PlatformAccessory<BaseContext>, type: typeof hapService, model: string): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    this.accessories.push(accessory);
    const serviceUUID = uuidGen.generate(id + type);

    // Setup HomeKit service
    accessory.addService(type, name, serviceUUID);

    // Register new accessory in HomeKit
    if (this.accessories.findIndex((accessory) => accessory.context.accID === id) > -1) {
      this.api.registerPlatformAccessories(PLUGIN_ID, PLUGIN_NAME, [accessory]);
    } else {
      this.log.warn(`Preventing adding existing ${model} ${name} with id ${id}`);
    }
  }

  /**
   * Removes accessories from the platform, homebridge and HomeKit.
   *
   * @param accessory  The accessory to be removed from the platform.
   */
  removeAccessory(accessory?: PlatformAccessory): void {
    if (!accessory) {
      return;
    }

    this.log.info(`Removing ${accessory.context.name} (${accessory.context.accID}) from HomeBridge`);
    this.api.unregisterPlatformAccessories(PLUGIN_ID, PLUGIN_NAME, [accessory]);
    this.accessories.splice(this.accessories.indexOf(accessory), 1);
  }

  /**
   * Removes all accessories from the platform, homebridge and HomeKit.
   * Useful for updating homebridge with the list of accessories present.
   */
  removeAccessories(): void {
    this.accessories.forEach((accessory) => this.removeAccessory(accessory));
  }

  /**
   * Helper function to write JSON payloads to log files for debugging and
   * troubleshooting scenarios with specific alarm system setups.
   *
   * @param payloadLogPath {string}  The path where the files should go.
   * @param payloadLogName {string}  The name of the file (should end in .json).
   * @param payload {*}  The output to populate the log file with.
   */
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
        // Log if there was an error creating the payload directory
        if (err) {
          this.log.error(prefix + err);
        } else {
          // Otherwise, we can attempt to write the payload
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

/**
 * Fetches all relationships for a system from Alarm.com
 *
 * @param res  Response object from loginSession().
 * @returns {Promise<[(number | bigint), number, number, number, number, number,
 *   number, number, number, number]>}  See SystemState.ts for return type.
 */
async function fetchStateForAllSystems(res: AuthOpts): Promise<FlattenedSystemState[]> {
  return Promise.all(res.systems.map((id: string) => getCurrentState(id, res)));
}

/**
 * Maps an Alarm.com alarm panel state to its counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {*}  The state as defines it.
 */
function getPartitionState(state: number): number {
  // console.log(`${sensor.attributes.description} Sensor (${sensor.id}) is ${sensor.attributes.stateText}.`)
  switch (state) {
    case SYSTEM_STATES.ARMED_STAY:
      return hapCharacteristic.SecuritySystemCurrentState.STAY_ARM;
    case SYSTEM_STATES.ARMED_AWAY:
      return hapCharacteristic.SecuritySystemCurrentState.AWAY_ARM;
    case SYSTEM_STATES.ARMED_NIGHT:
      return hapCharacteristic.SecuritySystemCurrentState.NIGHT_ARM;
    case SYSTEM_STATES.UNKNOWN:
    case SYSTEM_STATES.DISARMED:
    default:
      return hapCharacteristic.SecuritySystemCurrentState.DISARMED;
  }
}

/**
 * Maps an Alarm.com sensor state to its counterpart.
 *
 * @param sensor  The state as defined by Alarm.com.
 * @returns {*}  The state as defines it.
 */
function getSensorState(sensor: SensorState): CharacteristicValue {
  // Some sensors remain "open" until they are disrupted and need special treatment.
  if (sensor.attributes.deviceType == SensorType.Heat_Detector) {
    return sensor.attributes.state === 0
      ? hapCharacteristic.SmokeDetected.SMOKE_NOT_DETECTED
      : hapCharacteristic.SmokeDetected.SMOKE_DETECTED;
  }

  if (sensor.attributes.deviceType == SensorType.Glass_Break) {
    return sensor.attributes.openClosedStatus === 2
      ? hapCharacteristic.ContactSensorState.CONTACT_DETECTED
      : hapCharacteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  switch (sensor.attributes.state) {
    case SENSOR_STATES.OPEN:
      return hapCharacteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    case SENSOR_STATES.CLOSED:
      return hapCharacteristic.ContactSensorState.CONTACT_DETECTED;
    case SENSOR_STATES.ACTIVE:
      return hapCharacteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    case SENSOR_STATES.IDLE:
      return hapCharacteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
    case SENSOR_STATES.WET:
      return hapCharacteristic.LeakDetected.LEAK_DETECTED;
    case SENSOR_STATES.DRY:
      return hapCharacteristic.LeakDetected.LEAK_NOT_DETECTED;
    case SENSOR_STATES.UNKNOWN:
      return hapCharacteristic.StatusFault.GENERAL_FAULT;
    default:
      return -1;
  }
}

/**
 * Maps an Alarm.com light state to its counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as defines it.
 */
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

/**
 * Maps an Alarm.com lock state to its counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as defines it.
 */
function getLockCurrentState(state: number): CharacteristicValue {
  switch (state) {
    case LOCK_STATES.UNSECURED:
      return hapCharacteristic.LockCurrentState.UNSECURED;
    case LOCK_STATES.SECURED:
      return hapCharacteristic.LockCurrentState.SECURED;
    default:
      return hapCharacteristic.LockCurrentState.UNKNOWN;
  }
}

/**
 * Maps an Alarm.com lock state to its counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as defines it.
 */
function getLockTargetState(state: LOCK_STATES): CharacteristicValue {
  switch (state) {
    case LOCK_STATES.UNSECURED:
      return hapCharacteristic.LockTargetState.UNSECURED;
    case LOCK_STATES.SECURED:
      return hapCharacteristic.LockTargetState.SECURED;
    // If the lock is in an unknown state, we want it to come back online locked for security.
    default:
      return hapCharacteristic.LockTargetState.SECURED;
  }
}

/**
 * Maps an Alarm.com garage state to its counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as defines it.
 */
function getGarageState(state: number): CharacteristicValue {
  switch (state) {
    case GARAGE_STATES.OPEN:
      return hapCharacteristic.CurrentDoorState.OPEN;
    case GARAGE_STATES.CLOSED:
      return hapCharacteristic.CurrentDoorState.CLOSED;
    default:
      return hapCharacteristic.CurrentDoorState.STOPPED;
  }
}

/**
 * Maps an Alarm.com thermostat to its counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as defines it.
 */
function getThermostatState(state: number): CharacteristicValue {
  // Unknown how to handle THERMOSTAT_STATES.AUTO
  switch (state) {
    case THERMOSTAT_STATES.HEATING:
      return hapCharacteristic.CurrentHeatingCoolingState.HEAT;
    case THERMOSTAT_STATES.COOLING:
      return hapCharacteristic.CurrentHeatingCoolingState.COOL;
    case THERMOSTAT_STATES.OFF:
    default:
      return hapCharacteristic.CurrentHeatingCoolingState.OFF;
  }
}

function getThermostatTargetTemperature(thermostat: ThermostatState, convertToC: boolean): number {
  let value;

  switch (thermostat.attributes.desiredState) {
    case THERMOSTAT_STATES.HEATING:
      value = thermostat.attributes.desiredHeatSetpoint;
      break;
    case THERMOSTAT_STATES.COOLING:
      value = thermostat.attributes.desiredCoolSetpoint;
      break;
    case THERMOSTAT_STATES.AUTO:
    case THERMOSTAT_STATES.OFF:
    default:
      switch (thermostat.attributes.inferredState) {
        case THERMOSTAT_STATES.HEATING:
          value = thermostat.attributes.desiredHeatSetpoint;
          break;
        case THERMOSTAT_STATES.COOLING:
          value = thermostat.attributes.desiredCoolSetpoint;
          break;
      }
  }

  if (convertToC) {
    value = convertFtoC(value);
  }

  return value;
}

function convertFtoC(f: number): number {
  return Math.round((5 / 9) * (f - 32));
}

function convertCtoF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/**
 * Maps an Alarm.com sensor type to its counterpart.
 *
 * @param sensor  The type as defined by Alarm.com.
 * @returns {}  An array with details about its type as defines it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSensorType(sensor: SensorState): Array<any> {
  const state = sensor.attributes.state;
  const type = sensor.attributes.deviceType;

  switch (type) {
    case SensorType.Motion_Sensor:
      return [hapService.MotionSensor, hapCharacteristic.MotionDetected, 'Motion Sensor'];
    case SensorType.Smoke_Detector:
    case SensorType.Heat_Detector:
      return [hapService.SmokeSensor, hapCharacteristic.SmokeDetected, 'Heat Sensor'];
    case SensorType.CO_Detector:
      return [hapService.CarbonMonoxideSensor, hapCharacteristic.CarbonMonoxideDetected, 'Carbon Monoxide Detector'];
    case SensorType.Fob:
      return [hapService.AccessControl, hapCharacteristic.RemoteKey, 'Key fob'];
    case SensorType.Water_Sensor:
      return [hapService.LeakSensor, hapCharacteristic.LeakDetected, 'Water Sensor'];
    case SensorType.Contact_Sensor:
      return [hapService.ContactSensor, hapCharacteristic.ContactSensorState, 'Contact Sensor'];
    // On default, fall back to the old way of detecting sensor types. This will ensure we don't lose some
    //  devices we don't have types for
    default:
      switch (state) {
        case SENSOR_STATES.CLOSED:
        case SENSOR_STATES.OPEN:
          return [hapService.ContactSensor, hapCharacteristic.ContactSensorState, 'Contact Sensor'];
        case SENSOR_STATES.IDLE:
        case SENSOR_STATES.ACTIVE:
          return [hapService.OccupancySensor, hapCharacteristic.OccupancyDetected, 'Occupancy Sensor'];
        case SENSOR_STATES.DRY:
        case SENSOR_STATES.WET:
          return [hapService.LeakSensor, hapCharacteristic.LeakDetected, 'Leak Sensor'];
        default:
          return [undefined, undefined, undefined];
      }
  }
}

/**
 * Maps an Alarm.com sensor model to its type represented in homebridge/homekit.
 *
 * @param model  The model as reported by Alarm.com.
 * @returns {array}  An array with homebridge service and characteristic types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sensorModelToType(model: string): Array<any> {
  switch (model) {
    case 'Contact Sensor':
      return [hapService.ContactSensor, hapCharacteristic.ContactSensorState];
    case 'Occupancy Sensor':
      return [hapService.OccupancySensor, hapCharacteristic.OccupancyDetected];
    case 'Leak Sensor':
      return [hapService.LeakSensor, hapCharacteristic.LeakDetected];
    case 'Key fob':
      return [hapService.AccessControl, hapCharacteristic.RemoteKey];
    case 'Carbon Monoxide Detector':
      return [hapService.CarbonMonoxideSensor, hapCharacteristic.CarbonMonoxideDetected];
    case 'Smoke Detector':
    case 'Heat Sensor':
      return [hapService.SmokeSensor, hapCharacteristic.SmokeDetected];
    case 'Motion Sensor':
      return [hapService.MotionSensor, hapCharacteristic.MotionDetected];
    default:
      return [undefined, undefined];
  }
}
