import {
  API, APIEvent,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP, Logging, PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig
} from 'homebridge';

import fs from 'fs';

import {
  GARAGE_STATES,
  LIGHT_STATES,
  LOCK_STATES,
  SENSOR_STATES,
  SYSTEM_STATES
} from 'node-alarm-dot-com/dist/_models/States';

import path from 'path';

import {
  armAway,
  armStay,
  closeGarage,
  disarm,
  getCurrentState,
  login,
  openGarage,
  setLightOff,
  setLightOn,
  setLockSecure,
  setLockUnsecure,
  AuthOpts,
  GarageState,
  LightState,
  LockState,
  SensorState,
  FlattenedSystemState, DeviceState
} from 'node-alarm-dot-com';

import { SimplifiedSystemState } from './_models/SimplifiedSystemState';

let hap: HAP;
const PLUGIN_ID = 'homebridge-node-alarm-dot-com';
const PLUGIN_NAME = 'Alarmdotcom';
const MANUFACTURER = 'Alarm.com';
const AUTH_TIMEOUT_MINS = 10; // default for session authentication refresh
const POLL_TIMEOUT_SECS = 60; // default for device state polling
const LOG_LEVEL = 3; // default for log entries: 0 = NONE, 1 = ERROR, 2 = WARN, 3 = NOTICE, 4 = VERBOSE

let Accessory: typeof PlatformAccessory;
let Service: HAP['Service'];
let Characteristic: HAP['Characteristic'];
let UUIDGen: typeof import('hap-nodejs/dist/lib/util/uuid');

export = (api: API): void => {
  hap = api.hap;
  Accessory = api.platformAccessory;
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  api.registerPlatform(PLUGIN_ID, PLUGIN_NAME, ADCPlatform);
};

class ADCPlatform implements DynamicPlatformPlugin {

  public readonly log: Logging;
  public readonly api: API;
  /**
   * Used to keep track of restored, cached accessories
   * @private
   */
  private readonly accessories: PlatformAccessory[] = [];
  private authOpts: AuthOpts;
  private config: PlatformConfig;
  private logLevel: number;
  private armingModes: any;
  private ignoredDevices: string[];
  private useMFA: boolean;
  private mfaToken?: string;

  /**
   * The platform class constructor used when registering a plugin.
   *
   * @param log  The platform's logging function.
   * @param config  The platform's config.json section as object.
   * @param api  The homebridge API.
   */
  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.config = config || { platform: PLUGIN_NAME };
    this.logLevel = this.config.logLevel || LOG_LEVEL;
    this.ignoredDevices = this.config.ignoredDevices || [];
    this.useMFA = this.config.useMFA || false;
    this.mfaToken = this.config.useMFA ? this.config.mfaCookie : null;

    this.config.authTimeoutMinutes = this.config.authTimeoutMinutes || AUTH_TIMEOUT_MINS;
    this.config.pollTimeoutSeconds = this.config.pollTimeoutSeconds || POLL_TIMEOUT_SECS;

    this.authOpts = {
      expires: +new Date() - 1
    } as AuthOpts;

    // Default arming mode options
    this.armingModes = {
      'away': {
        nightArming: false,
        noEntryDelay: false,
        silentArming: false
      },
      'night': {
        nightArming: true,
        noEntryDelay: false,
        silentArming: true
      },
      'stay': {
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
  registerAlarmSystem() {
    // First, let's unregister any restored devices the user wants ignored
    this.accessories.forEach(accessory => {
      // If the device is ignored, we want to stop the restore
      const ignored = this.ignoredDevices.indexOf(accessory.context.accID) > -1;
      if (ignored) {
        this.log.debug(`Removing ignored device ${accessory.context.accID} from homebridge`);
        // Remove the accessory from HomeBridge
        this.removeAccessory(accessory);
      }
    });

    this.listDevices()
      .then(res => {
        this.log.debug('Registering system:');
        this.log.debug(res as any);

        for (const device in res) {
          if (device === 'partitions' && typeof res[device][0] === 'undefined') {
            // throw error if no partition, ideally this should never occur
            throw new Error('Received no partitions from Alarm.com');
          } else if (res[device].length > 0) {
            this.log.info(`Received ${res[device].length} ${device} from Alarm.com`);

            res[device].forEach((d: DeviceState) => {
              const deviceType = d.type;
              const realDeviceType = deviceType.split('/')[1];
              // Check so we don't add accessories which were already restored
              // Don't add devices which should be ignored
              if (!this.ignoredDevices.includes(d.id)) {
                const uuid = this.api.hap.uuid.generate(d.id);
                const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
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
      .catch(err => {
        this.log.error(`UNHANDLED ERROR: ${err.stack}`);
      });

    // Start a timer to periodically refresh status
    this.timerLoop();
  }

  /**
   * Create a randomized timer to refresh device state
   */
  timerLoop() {
    // Create a randomized delay by adding between 0 - 30 seconds to timer
    const timerDelay = (this.config.pollTimeoutSeconds * 1000) + (30000 * Math.random());
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
    if (accessory.context.partitionType) {
      this.setupPartition(accessory);
    } else if (accessory.context.sensorType) {
      this.setupSensor(accessory);
    } else if (accessory.context.lightType) {
      this.setupLight(accessory);
    } else if (accessory.context.lockType) {
      this.setupLock(accessory);
    } else if (accessory.context.garageType) {
      this.setupGarage(accessory);
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
      this.log.info(`Logging into Alarm.com as ${this.config.username}`);
      //const authOpts = await login(this.config.username, this.config.password, this.mfaToken);
      await login(this.config.username, this.config.password, this.mfaToken)
        .then(authOpts => {


          // Cache login response and estimated expiration time
          authOpts.expires = +new Date() + 1000 * 60 * this.config.authTimeoutMinutes;
          this.authOpts = authOpts;
          this.log.info(`Logged into Alarm.com as ${this.config.username}`);
        })
        .catch(err => {
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
    return systemStates.reduce((out, system) => {
      out.partitions = out.partitions.concat(system.partitions);
      out.sensors = out.sensors.concat(system.sensors);
      out.lights = out.lights.concat(system.lights);
      out.locks = out.locks.concat(system.locks);
      out.garages = out.garages.concat(system.garages);
      return out;
    }, {
      partitions: [],
      sensors: [],
      lights: [],
      locks: [],
      garages: []
    });
  }

  /**
   * Method to update state on accessories/devices.
   */
  async refreshDevices(): Promise<void> {
    await this.loginSession()
      .then(res => fetchStateForAllSystems(res))
      .then(systemStates => {

        // writes systemStates payload to a file for debug/troubleshooting
        if (this.logLevel > 3) {
          this.writePayload(this.api.user.storagePath() + '/', 'ADC-SystemStates.json', JSON.stringify(systemStates));
        }

        // break dist system components
        systemStates.forEach(system => {

          if (system.partitions) {
            system.partitions.forEach((partition) => {
              const accessory = this.accessories.find(accessory => accessory.context.accID === partition.id);
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
              const accessory = this.accessories.find(accessory => accessory.context.accID === sensor.id);
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
              const accessory = this.accessories.find(accessory => accessory.context.accID === light.id);
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
              const accessory = this.accessories.find(accessory => accessory.context.accID === lock.id);
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
              const accessory = this.accessories.find(accessory => accessory.context.accID === garage.id);
              if (!this.ignoredDevices.includes(garage.id)) {
                if (!accessory) {
                  return this.addGarage(garage);
                }
                this.statGarageState(accessory, garage);
              }
            });
          } else {
            this.log.info('No garage doors found, ignore if expected, or check configuration with security system provider');
          }

        });
      })
      .catch(err => {
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
    let accessory = this.accessories.find(accessory => accessory.context.accID === id);
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const name = partition.attributes.description;
    const uuid = UUIDGen.generate(id);
    accessory = new Accessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: null,
      desiredState: null,
      statusFault: null,
      partitionType: 'default'
    };

    this.log.info(`Adding partition ${name} (id=${id}, uuid=${uuid})`);

    this.addAccessory(accessory, Service.SecuritySystem, 'Security Panel');

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
  setupPartition(accessory: PlatformAccessory): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = 'Security Panel';

    // Setup HomeKit accessory information
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on('identify', () => {
      this.log.debug(`${name} identify requested`);
    });

    const service = accessory.getService(Service.SecuritySystem)!;

    service
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.state));

    service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue,
                  callback: CharacteristicSetCallback) => this.changePartitionState(accessory, value, callback));

    service
      .getCharacteristic(Characteristic.StatusFault)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.statusFault));
  }

  /**
   * Reports on the state of the alarm panel.
   *
   * @param accessory  The accessory representing the alarm panel.
   * @param partition  The alarm panel parameters from Alarm.com.
   */
  statPartitionState(accessory: PlatformAccessory, partition): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getPartitionState(partition.attributes.state);
    const desiredState = getPartitionState(partition.attributes.desiredState);
    const statusFault = Boolean(partition.attributes.needsClearIssuesPrompt);

    if (state !== accessory.context.state) {
      this.log.debug(`Updating partition ${name} (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;
      accessory
        .getService(Service.SecuritySystem)!
        .getCharacteristic(Characteristic.SecuritySystemCurrentState)
        .updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      this.log.info(`Updating partition ${name} (${id}), desiredState=${desiredState}, prev=${accessory.context.desiredState}`);

      accessory.context.desiredState = desiredState;
      accessory
        .getService(Service.SecuritySystem)!
        .getCharacteristic(Characteristic.SecuritySystemTargetState)
        .updateValue(desiredState);
    }

    if (statusFault !== accessory.context.statusFault) {
      this.log.info(`Updating partition ${name} (${id}), statusFault=${statusFault}, prev=${accessory.context.statusFault}`);

      accessory.context.statusFault = statusFault;
      accessory
        .getService(Service.SecuritySystem)!
        .getCharacteristic(Characteristic.StatusFault)
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
  async changePartitionState(accessory: PlatformAccessory, value: CharacteristicValue,
                             callback: CharacteristicSetCallback): Promise<void> {
    const id = accessory.context.accID;
    let method: typeof armAway | typeof armStay | typeof disarm;
    const opts = {} as any;

    switch (value) {
      case Characteristic.SecuritySystemTargetState.STAY_ARM:
        method = armStay;
        opts.noEntryDelay = this.armingModes.stay.noEntryDelay;
        opts.silentArming = this.armingModes.stay.silentArming;
        opts.nightArming = this.armingModes.stay.nightArming;
        break;
      case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
        method = armStay;
        opts.noEntryDelay = this.armingModes.night.noEntryDelay;
        opts.silentArming = this.armingModes.night.silentArming;
        opts.nightArming = this.armingModes.night.nightArming;
        break;
      case Characteristic.SecuritySystemTargetState.AWAY_ARM:
        method = armAway;
        opts.noEntryDelay = this.armingModes.away.noEntryDelay;
        opts.silentArming = this.armingModes.away.silentArming;
        opts.silentArming = this.armingModes.away.nightArming;
        break;
      case Characteristic.SecuritySystemTargetState.DISARM:
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
      .then(res => method(id, res, opts))
      .then(res => res.data)
      .then(partition => this.statPartitionState(accessory, partition))
      .then(_ => callback()) // need to determine why we need this
      .catch(err => {
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
    let accessory = this.accessories.find(accessory => accessory.context.accID === id);
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, characteristic, model] = getSensorType(sensor);
    if (type === undefined) {
      this.log.warn(`Warning: Sensor ${sensor.attributes.description} has unknown state ${sensor.attributes.state} (${sensor.id})`);
      return;
    }

    const name = sensor.attributes.description;
    const uuid = UUIDGen.generate(id);
    accessory = new Accessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: null,
      batteryLow: false,
      sensorType: model
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
   * Tells homebridge there is a sensor, exposing it's capabilities and state.
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
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.info(`${name} identify requested`);
    });

    const service = accessory.getService(type)!;

    service
      .getCharacteristic(characteristic)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.state));

    service
      .getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.batteryLow));
  }

  /**
   * Reports on the state of the sensor accessory.
   *
   * @param accessory  The accessory representing a sensor.
   * @param sensor  The sensor parameters from Alarm.com.
   */
  statSensorState(accessory: PlatformAccessory, sensor: SensorState): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getSensorState(sensor);
    const batteryLow = Boolean(sensor.attributes.lowBattery || sensor.attributes.criticalBattery);
    const [type, characteristic, model] = getSensorType(sensor);


    if (state !== accessory.context.state) {
      this.log.info(`Updating sensor ${name} (${model}) (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;
      accessory
        .getService(type)!
        .getCharacteristic(characteristic)
        .updateValue(state);
    }

    if (batteryLow !== accessory.context.batteryLow) {
      this.log.info(`Updating sensor ${name} (${id}), batteryLow=${batteryLow}, prev=${accessory.context.batteryLow}`);

      accessory.context.batteryLow = batteryLow;
      accessory
        .getService(type)!
        .getCharacteristic(Characteristic.StatusLowBattery)
        .updateValue(batteryLow);
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
    let accessory = this.accessories.find(accessory => accessory.context.accID === id);
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, model] = [
      Service.Lightbulb,
      'Light'
    ];

    const name = light.attributes.description;
    const uuid = UUIDGen.generate(id);
    accessory = new Accessory(name, uuid);

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
      this.log.info(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`);

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
  setupLight(accessory: PlatformAccessory): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.lightType;
    const type = Service.Lightbulb;

    // Setup HomeKit accessory information
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.info(`${name} identify requested`);
    });

    const service = accessory.getService(type)!;

    service
      .getCharacteristic(Characteristic.On)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.state);
      })
      .on('set', (on: CharacteristicValue, callback: CharacteristicSetCallback) => {
        this.changeLight(accessory, on, callback);
      });

    if (accessory.context.isDimmer) {
      service
        .getCharacteristic(Characteristic.Brightness)
        .on('get', (callback: CharacteristicGetCallback) => {
          callback(null, accessory.context.lightLevel);
        })
        .on('set', (brightness: CharacteristicValue, callback: CharacteristicSetCallback) => {
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
  statLightState(accessory: PlatformAccessory, light: LightState, callback?: CharacteristicSetCallback): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const newState = getLightState(light.attributes.state);
    const newBrightness = light.attributes.lightLevel;

    if (newState !== accessory.context.state) {
      this.log.info(`Updating light ${name} (${id}), state=${newState}, prev=${accessory.context.state}`);

      accessory.context.state = newState;

      accessory.getService(Service.Lightbulb)!
        .updateCharacteristic(Characteristic.On, newState);
    }

    if (accessory.context.isDimmer && newBrightness !== accessory.context.brightness) {
      accessory.context.brightness = newBrightness;
      accessory.getService(Service.Lightbulb)!
        .updateCharacteristic(Characteristic.Brightness, newBrightness);
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
  async changeLightBrightness(accessory: PlatformAccessory, brightness: CharacteristicValue,
                              callback: CharacteristicSetCallback): Promise<void> {
    const id = accessory.context.accID;

    this.log.info(`Changing light (${accessory.context.accID}, light level ${brightness})`);

    accessory.context.lightLevel = brightness;

    await this.loginSession()
      .then(res => setLightOn(id, res, accessory.context.lightLevel))
      .then(res => res.data)
      .then(light => {
        this.statLightState(accessory, light, callback);
      })
      .catch(err => {
        this.log.error(`Error: Failed to change light state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  /**
   * Change the physical state of a light using the Alarm.com API.
   *
   * @param accessory  The light to be changed.
   * @param {boolean} on  Value representing off or on states of the light.
   * @param callback
   */
  async changeLight(accessory: PlatformAccessory, on: CharacteristicValue,
                    callback: CharacteristicSetCallback): Promise<void> {
    // Alarm.com expects a single call for both brightness and 'on'
    // We need to ignore the extra call when changing brightness from homekit.
    if (on === accessory.context.state) {
      callback();
      return;
    }

    const id = accessory.context.accID;
    let method: typeof setLightOn | typeof setLightOff;

    if (on === true) {
      method = setLightOn;
    } else {
      method = setLightOff;
    }

    this.log.info(`Changing light (${accessory.context.accID}, ${on})`);

    accessory.context.state = on;

    await this.loginSession()
      .then(res => method(id, res, accessory.context.lightLevel ?? 100))
      .then(res => res.data)
      .then(light => {
        this.statLightState(accessory, light, callback);
      })
      .catch(err => {
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
    let accessory = this.accessories.find(accessory => accessory.context.accID === id);
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, model] = [
      Service.LockMechanism,
      'Door Lock'
    ];

    const name = lock.attributes.description;
    const uuid = UUIDGen.generate(id);
    accessory = new Accessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: lock.attributes.state,
      desiredState: lock.attributes.desiredState,
      lockType: model
    };

    // if the lock id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      this.log.info(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`);

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
  setupLock(accessory: PlatformAccessory): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.lockType;
    const [type, characteristic] = [
      Service.LockMechanism,
      Characteristic.LockCurrentState
    ];
    if (!characteristic && this.logLevel > 1) {
      throw new Error(`Unrecognized lock ${accessory.context.accID}`);
    }

    // Setup HomeKit accessory information
    const homeKitService = accessory.getService(Service.AccessoryInformation);

    if (homeKitService === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${accessory.context.accID}`);
    }

    homeKitService
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id);

    // Setup event listeners
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.info(`${name} identify requested`);
    });

    const service = accessory.getService(type);

    if (service === undefined) {
      throw new Error(`Trouble getting service for ${accessory.context.accID}`);
    }

    service
      .getCharacteristic(Characteristic.LockCurrentState)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.state);
      });

    service
      .getCharacteristic(Characteristic.LockTargetState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue,
                  callback: CharacteristicSetCallback) => this.changeLockState(accessory, value, callback));
  }

  /**
   * Reports on the state of the lock accessory.
   *
   * @param accessory  The accessory representing the lock accessory.
   * @param lock  The lock accessory parameters from Alarm.com.
   */
  statLockState(accessory: PlatformAccessory, lock: LockState): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getLockState(lock.attributes.state);
    const desiredState = getLockState(lock.attributes.desiredState);
    const service = accessory.getService(Service.LockMechanism);

    if (service === undefined) {
      throw new Error(`Trouble getting HomeKit accessory information for ${accessory.context.accID}`);
    }

    if (state !== accessory.context.state) {
      this.log.info(`Updating lock ${name} (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;

      service
        .getCharacteristic(Characteristic.LockCurrentState)
        .updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState;
      service
        .getCharacteristic(Characteristic.LockTargetState)
        .updateValue(desiredState);
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
  async changeLockState(accessory: PlatformAccessory, value: CharacteristicValue,
                        callback: CharacteristicSetCallback): Promise<void> {
    const id = accessory.context.accID;
    let method: typeof setLockSecure | typeof setLockUnsecure;

    switch (value) {
      case Characteristic.LockTargetState.UNSECURED:
        method = setLockUnsecure;
        break;
      case Characteristic.LockTargetState.SECURED:
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
      .then(res => method(id, res))
      .then(res => res.data)
      .then(lock => {
        this.statLockState(accessory, lock);
      })
      .then(_ => callback())
      .catch(err => {
        this.log.error(`Error: Failed to change lock state: ${err.stack}`);
        this.refreshDevices();
        callback(err);
      });
  }

  // Garage Methods /////////////////////////////////////////////////////////

  addGarage(garage: GarageState): void {
    const id = garage.id;
    let accessory = this.accessories.find(accessory => accessory.context.accID === id);
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean dist the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory);
    }

    const [type, model] = [
      Service.GarageDoorOpener,
      'Garage Door'
    ];

    const name = garage.attributes.description;
    const uuid = UUIDGen.generate(id);
    accessory = new Accessory(name, uuid);

    accessory.context = {
      accID: id,
      name: name,
      state: garage.attributes.state,
      desiredState: garage.attributes.desiredState,
      garageType: model
    };

    // if the garage id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      this.log.info(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`);

      this.addAccessory(accessory, type, model);
      this.setupGarage(accessory);

      // Set the initial garage state
      this.statGarageState(accessory, garage);
    }
  }

  setupGarage(accessory: PlatformAccessory): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const model = accessory.context.garageType;
    const [type, characteristic] = [
      Service.GarageDoorOpener,
      Characteristic.CurrentDoorState,
      Characteristic.TargetDoorState
      // Characteristic.ObstructionDetected
    ];

    if (!characteristic && this.config.logLevel > 1) {
      throw new Error(`Unrecognized garage door opener ${accessory.context.accID}`);
    }

    // Setup HomeKit accessory information
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id);

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
      .getCharacteristic(Characteristic.CurrentDoorState)
      .on('get', (callback: CharacteristicGetCallback) => {
        callback(null, accessory.context.state);
      });

    service
      .getCharacteristic(Characteristic.TargetDoorState)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.desiredState))
      .on('set', (value: CharacteristicValue,
                  callback: CharacteristicSetCallback) => this.changeGarageState(accessory, value, callback));
  }

  statGarageState(accessory: PlatformAccessory, garage: GarageState): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getGarageState(garage.attributes.state);
    const desiredState = getGarageState(garage.attributes.desiredState);

    if (state !== accessory.context.state) {
      this.log.info(`Updating garage ${name} (${id}), state=${state}, prev=${accessory.context.state}`);

      accessory.context.state = state;

      accessory
        .getService(Service.GarageDoorOpener)!
        .getCharacteristic(Characteristic.CurrentDoorState)
        .updateValue(state);
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState;
      accessory
        .getService(Service.GarageDoorOpener)!
        .getCharacteristic(Characteristic.TargetDoorState)
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

  async changeGarageState(accessory: PlatformAccessory, value: CharacteristicValue,
                          callback: CharacteristicSetCallback): Promise<void> {
    const id = accessory.context.accID;
    let method: typeof openGarage | typeof closeGarage;

    this.log.debug(String(value));

    switch (value) {
      case Characteristic.TargetDoorState.OPEN:
        method = openGarage;
        break;
      case Characteristic.TargetDoorState.CLOSED:
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
      .then(res => method(id, res)) // Usually 20-30 seconds
      .then(res => res.data)
      .then(garage => {
        this.statGarageState(accessory, garage);
      })
      .then(_ => callback())
      .catch(err => {
        this.log.error(`Error: Failed to change garage state: ${err.stack}`);
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
  addAccessory(accessory: PlatformAccessory, type: typeof Service, model: string): void {
    const id = accessory.context.accID;
    const name = accessory.context.name;
    this.accessories.push(accessory);

    // Setup HomeKit service
    accessory.addService(type, name);

    // Register new accessory in HomeKit
    if (this.accessories.findIndex(accessory => accessory.context.accID === id) > -1) {
      this.api.registerPlatformAccessories(PLUGIN_ID, PLUGIN_NAME, [accessory]);
    } else {
      this.log.warn(`Preventing adding existing accessory ${name} with id ${id}`);
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
    this.accessories.forEach(accessory => this.removeAccessory(accessory));
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
    const formatted_datetime = now.toLocaleString();
    const name = this.config.name;
    const prefix = '[' + formatted_datetime + '] [' + name + '] ';

    fs.mkdir(path.dirname(payloadLogPath), {
      recursive: true
    }, (err) => {
      if (err) {
        console.log(prefix + err);
      } else {
        fs.writeFile(payloadLogPath + payloadLogName, payload, {
          flag: 'w+'
        }, (err) => {
          if (err) {
            console.log(prefix + err);
          } else {
            console.log(prefix + payloadLogPath + payloadLogName + ' written');
          }
        });
      }
    });
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
      return Characteristic.SecuritySystemCurrentState.STAY_ARM;
    case SYSTEM_STATES.ARMED_AWAY:
      return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    case SYSTEM_STATES.ARMED_NIGHT:
      return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
    case SYSTEM_STATES.UNKNOWN:
    case SYSTEM_STATES.DISARMED:
    default:
      return Characteristic.SecuritySystemCurrentState.DISARMED;
  }
}

/**
 * Maps an Alarm.com sensor state to its counterpart.
 *
 * @param sensor  The state as defined by Alarm.com.
 * @returns {*}  The state as defines it.
 */
function getSensorState(sensor: SensorState): CharacteristicValue {
  // console.log(`${sensor.attributes.description} Sensor (${sensor.id}) is ${sensor.attributes.stateText}.`)
  switch (sensor.attributes.state) {
    case SENSOR_STATES.OPEN:
      return Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    case SENSOR_STATES.CLOSED:
      return Characteristic.ContactSensorState.CONTACT_DETECTED;
    case SENSOR_STATES.ACTIVE:
      return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    case SENSOR_STATES.IDLE:
      return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
    case SENSOR_STATES.WET:
      return Characteristic.LeakDetected.LEAK_DETECTED;
    case SENSOR_STATES.DRY:
      return Characteristic.LeakDetected.LEAK_NOT_DETECTED;
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
function getLockState(state: number): CharacteristicValue {
  switch (state) {
    case LOCK_STATES.UNSECURED:
      return Characteristic.LockCurrentState.UNSECURED;
    case LOCK_STATES.SECURED:
      return Characteristic.LockCurrentState.SECURED;
    default:
      return Characteristic.LockCurrentState.UNKNOWN;
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
      return Characteristic.CurrentDoorState.OPEN;
    case GARAGE_STATES.CLOSED:
      return Characteristic.CurrentDoorState.CLOSED;
    default:
      return Characteristic.CurrentDoorState.STOPPED;
  }
}

/**
 * Maps an Alarm.com sensor type to its counterpart.
 *
 * @param sensor  The type as defined by Alarm.com.
 * @returns {}  An array with details about its type as defines it.
 */
function getSensorType(sensor: SensorState): Array<any> {
  const state = sensor.attributes.state;

  switch (state) {
    case SENSOR_STATES.CLOSED:
    case SENSOR_STATES.OPEN:
      return [
        Service.ContactSensor,
        Characteristic.ContactSensorState,
        'Contact Sensor'
      ];
    case SENSOR_STATES.IDLE:
    case SENSOR_STATES.ACTIVE:
      return [
        Service.OccupancySensor,
        Characteristic.OccupancyDetected,
        'Occupancy Sensor'
      ];
    case SENSOR_STATES.DRY:
    case SENSOR_STATES.WET:
      return [
        Service.LeakSensor,
        Characteristic.LeakDetected,
        'Leak Sensor'
      ];
    default:
      return [
        undefined,
        undefined,
        undefined
      ];
  }
}

/**
 * Maps an Alarm.com sensor model to its type represented in homebridge/homekit.
 *
 * @param model  The model as reported by Alarm.com.
 * @returns {array}  An array with homebridge service and characteristic types.
 */
function sensorModelToType(model: string): Array<any> {
  switch (model) {
    case 'Contact Sensor':
      return [
        Service.ContactSensor,
        Characteristic.ContactSensorState
      ];
    case 'Occupancy Sensor':
      return [
        Service.OccupancySensor,
        Characteristic.OccupancyDetected
      ];
    case 'Leak Sensor':
      return [
        Service.LeakSensor,
        Characteristic.LeakDetected
      ];
    default:
      return [
        undefined,
        undefined
      ];
  }
}
