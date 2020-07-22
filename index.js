const nodeADC = require('node-alarm-dot-com')
const fs = require('fs')
const path = require('path')

const PLUGIN_ID = 'homebridge-node-alarm-dot-com'
const PLUGIN_NAME = 'Alarmdotcom'
const MANUFACTURER = 'Alarm.com'
const AUTH_TIMEOUT_MINS = 10 // default for session authentication refresh
const POLL_TIMEOUT_SECS = 60 // default for device state polling
const LOG_LEVEL = 3 // default for log entries: 0 = NONE, 1 = ERROR, 2 = WARN, 3 = NOTICE, 4 = VERBOSE

let Accessory, Service, Characteristic, UUIDGen

module.exports = function (homebridge) {
  Accessory = homebridge.platformAccessory
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  UUIDGen = homebridge.hap.uuid

  homebridge.registerPlatform(PLUGIN_ID, PLUGIN_NAME, ADCPlatform, true)
}

class ADCPlatform {

  /**
   * The platform class constructor used when registering a plugin.
   *
   * @param log  The platform's logging function.
   * @param config  The platform's config.json section as object.
   * @param api  The homebridge API.
   */
  constructor(log, config, api) {

    this.log = log
    this.config = config || { platform: PLUGIN_NAME }
    this.debug = this.config.debug || false
    this.logLevel = this.config.logLevel || LOG_LEVEL
    this.ignoredDevices = this.config.ignoredDevices || []

    this.config.authTimeoutMinutes = this.config.authTimeoutMinutes || AUTH_TIMEOUT_MINS
    this.config.pollTimeoutSeconds = this.config.pollTimeoutSeconds || POLL_TIMEOUT_SECS

    this.accessories = []
    this.authOpts = {
      expires: +new Date() - 1
    }

    // Default arming mode options
    this.armingModes = {
      'away': {
        noEntryDelay: false,
        silentArming: false
      },
      'night': {
        noEntryDelay: false,
        silentArming: true
      },
      'stay': {
        noEntryDelay: false,
        silentArming: true
      }
    };

    // Overwrite default arming modes with config settings.
    if (this.config.armingModes !== undefined) {
      for (var key in this.config.armingModes) {
        this.armingModes[key].noEntryDelay = Boolean(this.config.armingModes[key].noEntryDelay)
        this.armingModes[key].silentArming = Boolean(this.config.armingModes[key].silentArming)
      }
    }

    // Finally, check to see if the homebridge api is available and that the
    // necessary config variables are present
    if (!api && !config) {
      return
    } else {
      this.api = api

      if (!this.config.username) {
        this.log(MANUFACTURER + ': Missing required username in config')
        return
      }
      if (!this.config.password) {
        this.log(MANUFACTURER + ': Missing required password in config')
        return
      }

      this.api.on('didFinishLaunching', this.registerAlarmSystem.bind(this))

    }

  }

  // List and Add Devices //////////////////////////////////////////////////////

  /**
   * When the homebridge api finally registers the plugin, homebridge fires the
   * didFinishLaunching event, which in turn, launches the following
   * registerAlarmSystem method
   */
  registerAlarmSystem() {
    this.listDevices()
      .then(res => {

        for (var device in res) {
          if (device === 'partitions' && typeof res[device][0] == 'undefined') {
            // throw error if no partition, ideally this should never occur
            throw new Error(`Received no partitions from Alarm.com`)
          } else if (res[device].length > 0) {
            if (this.logLevel > 2) {
              this.log(`Received ${res[device].length} ${device} from Alarm.com`)
            }

            res[device].forEach(d => {
              var deviceType = d.type
              var realDeviceType = deviceType.split('/')[1]

              if (!this.ignoredDevices.includes(d.id)) {
                if (realDeviceType === 'partition') {
                  this.addPartition(d)
                } else if (realDeviceType === 'sensor') {
                  this.addSensor(d)
                } else if (realDeviceType === 'light') {
                  this.addLight(d)
                } else if (realDeviceType === 'lock') {
                  this.addLock(d)
                  else if (realDeviceType === 'garages')
                }
                // add more devices here as available, ie. garage doors, etc

                if (this.logLevel > 2) {
                  this.log(`Added ${realDeviceType} ${d.attributes.description} (${d.id})`)
                }
              } else {
                if (this.logLevel > 2) {
                  this.log(`Ignored sensor ${d.attributes.description} (${d.id})`)
                }
              }
            })
          } else {
            if (this.logLevel > 3) {
              this.log(`Received no ${device} from Alarm.com. If you are expecting
              ${device} in your Alarm.com setup, you may need to check that your
              provider has assigned ${device} in your Alarm.com account`)
            }
          }
        }

      })
      .catch(err => {
        if (this.logLevel > 0) {
          this.log(`UNHANDLED ERROR: ${err.stack}`)
        }
      })

    // Start a timer to periodically refresh status
    this.timerID = setInterval(
      () => this.refreshDevices(),
      this.config.pollTimeoutSeconds * 1000
    )
  }

  /**
   * REQUIRED: This method is called by homebridge to instantiate the accessory
   * from the accessory cache.
   *
   * @param {object} accessory  The accessory in question.
   */
  configureAccessory(accessory) {

    if (this.logLevel > 2) {
      this.log(`Loaded from cache: ${accessory.context.name} (${accessory.context.accID})`)
    }

    const existing = this.accessories[accessory.context.accID]
    if (existing) {
      this.removeAccessory(existing)
    }

    if (accessory.context.partitionType) {
      this.setupPartition(accessory)
    } else if (accessory.context.sensorType) {
      this.setupSensor(accessory)
    } else {
      if (this.logLevel > 1) {
        this.log(`Unrecognized accessory ${accessory.context.accID}`)
      }
    }

    this.accessories[accessory.context.accID] = accessory
  }


  // Internal Methods //////////////////////////////////////////////////////////

  /**
   * Method to retrieve/store/maintain login session state for the account.
   */
  login() {
    // Cache expiration check
    const now = +new Date()
    if (this.authOpts.expires > now) {
      return Promise.resolve(this.authOpts)
    }

    if (this.logLevel > 2) {
      this.log(`Logging into Alarm.com as ${this.config.username}`)
    }

    return nodeADC.login(this.config.username, this.config.password)
      .then(authOpts => {
        // Cache login response and estimated expiration time
        authOpts.expires = +new Date() + 1000 * 60 * this.config.authTimeoutMinutes
        this.authOpts = authOpts

        if (this.logLevel > 2) {
          this.log(`Logged into Alarm.com as ${this.config.username}`)
        }

        return authOpts
      })
  }

  /**
   * Method to gather devices and transform into a usable object.
   */
  listDevices() {
    return this.login()
      .then(res => fetchStateForAllSystems(res))
      .then(systemStates => {
        return systemStates.reduce(
          (out, system) => {
            out.partitions = out.partitions.concat(system.partitions)
            out.sensors = out.sensors.concat(system.sensors)
            out.lights = out.lights.concat(system.lights)
            out.locks = out.locks.concat(system.locks)
            out.garages = out.garages.concat(system.garages)
            return out
          }, {
            partitions: [],
            sensors: [],
            lights: [],
            locks: [],
            garages: []
          }
        )
      })
  }

  /**
   * Method to update state on accessories/devices.
   */
  refreshDevices() {
    this.login()
      .then(res => fetchStateForAllSystems(res))
      .then(systemStates => {

        // writes systemStates payload to a file for debug/troubleshooting
        if (this.logLevel > 3) {
          this.writePayload(this.api.user.storagePath() + '/', 'ADC-SystemStates.json', JSON.stringify(systemStates))
        }

        // break out system components
        systemStates.forEach(system => {

          if (system.partitions) {
            system.partitions.forEach(partition => {
              const accessory = this.accessories[partition.id]
              if (!accessory) {
                return this.addPartition(partition)
              }
              this.statPartitionState(accessory, partition)
            })
          } else {
            // fatal error, we require partitions and cannot continue
            throw new Error('No partitions found, check configuration with security system provider')
          }

          if (system.sensors) {
            system.sensors.forEach(sensor => {
              const accessory = this.accessories[sensor.id]
              if (!accessory) {
                return this.addSensor(sensor)
              }
              this.statSensorState(accessory, sensor)
            })
          } else {
            if (this.logLevel > 2)
              this.log('No sensors found, ignore if expected, or check configuration with security system provider')
          }

          if (system.lights) {
            system.lights.forEach(light => {
              const accessory = this.accessories[light.id]
              if (!accessory) {
                return this.addLight(lock)
              }
              this.statLightState(accessory, light)
            })
          } else {
            if (this.logLevel > 2)
              this.log('No lights found, ignore if expected, or check configuration with security system provider')
          }

          if (system.locks) {
            system.locks.forEach(lock => {
              const accessory = this.accessories[lock.id]
              if (!accessory) {
                return this.addLock(lock)
              }
              this.statLockState(accessory, lock)
            })
          } else {
            if (this.logLevel > 2)
              this.log('No locks found, ignore if expected, or check configuration with security system provider')
          }

          if (system.garages) {
            system.garages.forEach(lock => {
              const accessory = this.accessories[garage.id]
              if (!accessory) {
                return this.addGarage(garage)
              }
              this.statGarageState(accessory, garage)
            })
          } else {
            if (this.logLevel > 2)
              this.log('No garages found, ignore if expected, or check configuration with security system provider')
          }

        })
      })
      .catch(err => this.log(err))
  }


  // Partition Methods /////////////////////////////////////////////////////////

  /**
   * Adds necessary parameters of the alarm panel for homebridge before passing
   * it to further setup methods.
   *
   * @param {Object} partition  Passed in partition object from Alarm.com
   */
  addPartition(partition) {
    const id = partition.id
    let accessory = this.accessories[id]
    if (accessory) {
      this.removeAccessory(accessory)
    }

    const name = partition.attributes.description
    const uuid = UUIDGen.generate(id)
    accessory = new Accessory(name, uuid)

    accessory.context = {
      accID: id,
      name: name,
      state: null,
      desiredState: null,
      statusFault: null,
      partitionType: 'default'
    }

    if (this.logLevel > 2) {
      this.log(`Adding partition ${name} (id=${id}, uuid=${uuid})`)
    }

    this.addAccessory(accessory, Service.SecuritySystem, 'Security Panel')

    this.setupPartition(accessory)

    // Set the initial partition state
    this.statPartitionState(accessory, partition)
  }

  /**
   * Tells homebridge there is an alarm panel, exposing it's capabilities and
   * state.
   *
   * @param accessory  The accessory representing the alarm panel.
   */
  setupPartition(accessory) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const model = 'Security Panel'

    // Always reachable
    accessory.reachable = true

    // Setup HomeKit accessory information
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id)

    // Setup event listeners
    accessory.on('identify', (paired, callback) => {
      if (this.logLevel > 3) {
        this.log(`${name} identify requested, paired=${paired}`)
      }

      callback()
    })

    const service = accessory.getService(Service.SecuritySystem)

    service
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .on('get', callback => callback(null, accessory.context.state))

    service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .on('get', callback => callback(null, accessory.context.desiredState))
      .on('set', (value, callback) =>
        this.changePartitionState(accessory, value, callback)
      )

    service
      .getCharacteristic(Characteristic.StatusFault)
      .on('get', callback => callback(null, accessory.context.statusFault))
  }

  /**
   * Reports on the state of the alarm panel.
   *
   * @param accessory  The accessory representing the alarm panel.
   * @param partition  The alarm panel parameters from Alarm.com.
   */
  statPartitionState(accessory, partition) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const state = getPartitionState(partition.attributes.state)
    const desiredState = getPartitionState(partition.attributes.desiredState)
    const statusFault = Boolean(partition.attributes.needsClearIssuesPrompt)

    if (state !== accessory.context.state) {
      if (this.logLevel > 2) {
        this.log(`Updating partition ${name} (${id}), state=${state}, prev=${accessory.context.state}`)
      }

      accessory.context.state = state
      accessory
        .getService(Service.SecuritySystem)
        .getCharacteristic(Characteristic.SecuritySystemCurrentState)
        .updateValue(state)
    }

    if (desiredState !== accessory.context.desiredState) {
      if (this.logLevel > 2) {
        this.log(`Updating partition ${name} (${id}), desiredState=${desiredState}, prev=${accessory.context.desiredState}`)
      }

      accessory.context.desiredState = desiredState
      accessory
        .getService(Service.SecuritySystem)
        .getCharacteristic(Characteristic.SecuritySystemTargetState)
        .updateValue(desiredState)
    }

    if (statusFault !== accessory.context.statusFault) {
      if (this.logLevel > 2) {
        this.log(`Updating partition ${name} (${id}), statusFault=${statusFault}, prev=${accessory.context.statusFault}`)
      }

      accessory.context.statusFault = statusFault
      accessory
        .getService(Service.SecuritySystem)
        .getCharacteristic(Characteristic.StatusFault)
        .updateValue(statusFault)
    }
  }

  /**
   * Changes/sets the state of the alarm panel.
   *
   * @param accessory  The accessory representing the alarm panel.
   * @param sensor  The alarm panel parameters from Alarm.com.
   * @param callback
   */
  changePartitionState(accessory, value, callback) {
    const id = accessory.context.accID
    let method
    const opts = {}

    switch (value) {
      case Characteristic.SecuritySystemTargetState.STAY_ARM:
        method = nodeADC.armStay
        opts.noEntryDelay = this.armingModes.stay.noEntryDelay;
        opts.silentArming = this.armingModes.stay.silentArming;
        break
      case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
        method = nodeADC.armStay
        opts.noEntryDelay = this.armingModes.night.noEntryDelay;
        opts.silentArming = this.armingModes.night.silentArming;
        break
      case Characteristic.SecuritySystemTargetState.AWAY_ARM:
        method = nodeADC.armAway
        opts.noEntryDelay = this.armingModes.away.noEntryDelay;
        opts.silentArming = this.armingModes.away.silentArming;
        break
      case Characteristic.SecuritySystemTargetState.DISARM:
        method = nodeADC.disarm
        break
      default:
        const msg = `Can't set SecuritySystem to unknown value ${value}`
        if (this.logLevel > 1) {
          this.log(msg)
        }
        return callback(new Error(msg))
    }

    if (this.logLevel > 2) {
      this.log(`changePartitionState(${accessory.context.accID}, ${value})`)
    }

    accessory.context.desiredState = value

    this.login()
      .then(res => method(id, res, opts))
      .then(res => res.data)
      .then(partition => this.statPartitionState(accessory, partition))
      .then(_ => callback()) // need to determine why we need this
      .catch(err => {
        this.log(`Error: Failed to change partition state: ${err.stack}`)
        this.refreshDevices()
        callback(err)
      })
  }

  // Sensor Methods ////////////////////////////////////////////////////////////

  /**
   * Adds necessary parameters to a sensor for homebridge before passing it to
   * further setup methods.
   *
   * @param {Object} sensor  Passed in sensor object from Alarm.com
   */
  addSensor(sensor) {
    const id = sensor.id
    let accessory = this.accessories[id]
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean out the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory)
    }

    const [type, characteristic, model] = getSensorType(sensor)
    if (type === undefined) {
      if (this.logLevel > 1) {
        this.log(`Warning: Sensor with unknown state ${sensor.attributes.state}`)
      }

      return
    }

    const name = sensor.attributes.description
    const uuid = UUIDGen.generate(id)
    accessory = new Accessory(name, uuid)

    accessory.context = {
      accID: id,
      name: name,
      state: null,
      batteryLow: false,
      sensorType: model
    }

    // if the sensor id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      if (this.logLevel > 2) {
        this.log(`Adding ${model} "${name}" (id=${id}, uuid=${uuid})`)
      }

      this.addAccessory(accessory, type, model)
      this.setupSensor(accessory)

      // Set the initial sensor state
      this.statSensorState(accessory, sensor)
    }
  }

  /**
   * Tells homebridge there is a sensor, exposing it's capabilities and state.
   *
   * @param accessory  The accessory representing a sensor
   */
  setupSensor(accessory) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const model = accessory.context.sensorType
    const [type, characteristic] = sensorModelToType(model)
    if (!characteristic && this.logLevel > 1) {
      throw new Error(`Unrecognized sensor ${accessory.context.accID}`)
    }

    // Always reachable
    accessory.reachable = true

    // Setup HomeKit accessory information
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id)

    // Setup event listeners

    accessory.on('identify', (paired, callback) => {
      if (this.logLevel > 2) {
        this.log(`${name} identify requested, paired=${paired}`)
      }

      callback()
    })

    const service = accessory.getService(type)

    service
      .getCharacteristic(characteristic)
      .on('get', callback => callback(null, accessory.context.state))

    service
      .getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', callback => callback(null, accessory.context.batteryLow))
  }

  /**
   * Reports on the state of the sensor accessory.
   *
   * @param accessory  The accessory representing a sensor.
   * @param sensor  The sensor parameters from Alarm.com.
   */
  statSensorState(accessory, sensor) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const state = getSensorState(sensor)
    const batteryLow = Boolean(
      sensor.attributes.lowBattery || sensor.attributes.criticalBattery
    )
    const [type, characteristic, model] = getSensorType(sensor)



    if (state !== accessory.context.state) {
      if (this.logLevel > 2) {
        this.log(`Updating sensor ${name} (${id}), state=${state}, prev=${accessory.context.state}`)
      }

      accessory.context.state = state
      accessory
        .getService(type)
        .getCharacteristic(characteristic)
        .updateValue(state)
    }

    if (batteryLow !== accessory.context.batteryLow) {
      if (this.logLevel > 2) {
        this.log(`Updating sensor ${name} (${id}), batteryLow=${batteryLow}, prev=${accessory.context.batteryLow}`)
      }

      accessory.context.batteryLow = batteryLow
      accessory
        .getService(type)
        .getCharacteristic(Characteristic.StatusLowBattery)
        .updateValue(batteryLow)
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
  addLight(light) {
    const id = light.id
    let accessory = this.accessories[id]
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean out the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory)
    }

    const [type, model] = [
      Service.Lightbulb,
      'Light'
    ]

    const name = light.attributes.description
    const uuid = UUIDGen.generate(id)
    accessory = new Accessory(name, uuid)

    accessory.context = {
      accID: id,
      name: name,
      state: light.attributes.state,
      desiredState: light.attributes.desiredState,
      isDimmer: light.attributes.isDimmer,
      lightLevel: light.attributes.lightLevel,
      lightType: model
    }

    // if the light id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      if (this.logLevel > 2) {
        this.log(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`)
      }

      this.addAccessory(accessory, type, model)
      this.setupLight(accessory)

      // Set the initial light state
      this.statLightState(accessory, light)
    }
  }

  /**
   * Tells homebridge there is a light, exposing it's capabilities and state.
   *
   * @param accessory  The accessory representing a light.
   */
  setupLight(accessory) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const model = accessory.context.lightType
    const type = Service.Lightbulb

    // Always reachable
    accessory.reachable = true

    // Setup HomeKit accessory information
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id)

    // Setup event listeners

    accessory.on('identify', (paired, callback) => {
      if (this.logLevel > 2) {
        this.log(`${name} identify requested, paired=${paired}`)
      }

      callback()
    })

    const service = accessory.getService(type)

    service
      .getCharacteristic(Characteristic.On)
      .on('get', callback => {
        callback(null, accessory.context.state)
      })
      .on('set', (value, callback) => this.changeLightState(accessory, value, accessory.context.state, callback));

    if (accessory.context.isDimmer) {
      service
        .getCharacteristic(Characteristic.Brightness)
        .on('get', callback => callback(null, accessory.context.lightLevel))
        .on('set', (value, callback) => this.changeLightState(accessory, value, accessory.context.lightLevel, callback))
    }
  }

  /**
   * Reports on the state of the light accessory.
   *
   * @param accessory  The accessory representing the light accessory.
   * @param light  The light accessory parameters from Alarm.com.
   */
  statLightState(accessory, light) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const state = getLightState(light.attributes.state)
    const brightness = light.attributes.lightLevel

    if (state !== accessory.context.state) {
      if (this.logLevel > 2) {
        this.log(`Updating light ${name} (${id}), state=${state}, prev=${accessory.context.state}`)
      }

      accessory.context.state = state
      accessory
        .getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.On)
        .updateValue(state)
    }

    if (accessory.context.isDimmer && brightness !== accessory.context.brightness) {
      accessory.context.brightness = brightness
      accessory
        .getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.Brightness)
        .updateValue(brightness)
    }
  }

  /**
   * Change the physical state of a light using the Alarm.com API.
   *
   * @param accessory  The light to be changed.
   * @param {boolean} value  Value representing off or on states of the light.
   * @param {number} brightness  The brightness of a light, from 0-100 (only
   *    works with dimmers).
   * @param callback
   */
  changeLightState(accessory, value, brightness, callback) {
    const id = accessory.context.accID
    let method

    if (value) {
      method = nodeADC.setLightOn
    } else {
      method = nodeADC.setLightOff
    }

    if (this.logLevel > 2) {
      this.log(`Changing light (${accessory.context.accID}, ${value} light level ${brightness})`)
    }

    accessory.context.state = value
    accessory.context.lightLevel = brightness

    this.login()
      .then(res => method(id, res, brightness))
      .then(res => res.data)
      .then(light => {
        this.statLightState(accessory, light)
      })
      .then(callback()) // need to determine why we need this
      .catch(err => {
        this.log(`Error: Failed to change light state: ${err.stack}`)
        this.refreshDevices()
        callback(err)
      })
  }


  // Lock Methods /////////////////////////////////////////////////////////

  /**
   * Adds necessary parameters to a lock for homebridge before passing it to
   * further setup methods.
   *
   * @param {Object} lock  Passed in lock object from Alarm.com.
   */
  addLock(lock) {
    const id = lock.id
    let accessory = this.accessories[id]
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean out the cache of alarm accessories
    if (accessory) {
      this.removeAccessory(accessory)
    }

    const [type, model] = [
      Service.LockMechanism,
      'Door Lock'
    ]

    const name = lock.attributes.description
    const uuid = UUIDGen.generate(id)
    accessory = new Accessory(name, uuid)

    accessory.context = {
      accID: id,
      name: name,
      state: lock.attributes.state,
      desiredState: lock.attributes.desiredState,
      lockType: model
    }

    // if the lock id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      if (this.logLevel > 2) {
        this.log(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`)
      }

      this.addAccessory(accessory, type, model)
      this.setupLock(accessory)

      // Set the initial lock state
      this.statLockState(accessory, lock)
    }
  }

  /**
   * Tells homebridge there is a lock, exposing it's capabilities and state.
   *
   * @param accessory  The accessory representing a lock.
   */
  setupLock(accessory) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const model = accessory.context.lockType
    const [type, characteristic] = [
      Service.LockMechanism,
      Characteristic.LockCurrentState,
    ]
    if (!characteristic && this.logLevel > 1) {
      throw new Error(`Unrecognized lock ${accessory.context.accID}`)
    }

    // Always reachable
    accessory.reachable = true

    // Setup HomeKit accessory information
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id)

    // Setup event listeners

    accessory.on('identify', (paired, callback) => {
      if (this.logLevel > 2) {
        this.log(`${name} identify requested, paired=${paired}`)
      }

      callback()
    })

    const service = accessory.getService(type)

    service
      .getCharacteristic(Characteristic.LockCurrentState)
      .on('get', callback => {
        callback(null, accessory.context.state)
      })

    service
      .getCharacteristic(Characteristic.LockTargetState)
      .on('get', callback => callback(null, accessory.context.desiredState))
      .on('set', (value, callback) => this.changeLockState(accessory, value, callback))
  }

  /**
   * Reports on the state of the lock accessory.
   *
   * @param accessory  The accessory representing the lock accessory.
   * @param lock  The lock accessory parameters from Alarm.com.
   */
  statLockState(accessory, lock) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const state = getLockState(lock.attributes.state)
    const desiredState = getLockState(lock.attributes.desiredState)

    if (state !== accessory.context.state) {
      if (this.logLevel > 2) {
        this.log(`Updating lock ${name} (${id}), state=${state}, prev=${accessory.context.state}`)
      }

      accessory.context.state = state
      accessory
        .getService(Service.LockMechanism)
        .getCharacteristic(Characteristic.LockCurrentState)
        .updateValue(state)
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState
      accessory
        .getService(Service.LockMechanism)
        .getCharacteristic(Characteristic.LockTargetState)
        .updateValue(desiredState)
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
  changeLockState(accessory, value, callback) {
    const id = accessory.context.accID
    let method
    const opts = {}

    switch (value) {
      case Characteristic.LockTargetState.UNSECURED:
        method = nodeADC.setLockUnsecure
        break
      case Characteristic.LockTargetState.SECURED:
        method = nodeADC.setLockSecure
        break
      default:
        const msg = `Can't set LockMechanism to unknown value ${value}`
        if (this.logLevel > 1) {
          this.log(msg)
        }
        return callback(new Error(msg))
    }

    if (this.logLevel > 2) {
      this.log(`(un)secureLock)(${accessory.context.accID}, ${value})`)
    }

    accessory.context.desiredState = value

    this.login()
      .then(res => method(id, res, opts))
      .then(res => res.data)
      .then(lock => {
        this.statLockState(accessory, lock)
      })
      .then(_ => callback())
      .catch(err => {
        this.log(`Error: Failed to change lock state: ${err.stack}`)
        this.refreshDevices()
        callback(err)
      })
  }

  // Garage Methods /////////////////////////////////////////////////////////

  addGarage(garage) {
    const id = garage.id
    let accessory = this.accessories[id]
    // in an ideal world, homebridge shouldn't be restarted too often
    // so upon starting we clean out the cache of alarm accessories
    if (accessory)
      this.removeAccessory(accessory)

    const [type, model] = [
      Service.GarageDoorOpener,
      'Garage Door'
    ]

    const name = garage.attributes.description
    const uuid = UUIDGen.generate(id)
    accessory = new Accessory(name, uuid)

    accessory.context = {
      accID: id,
      name: name,
      state: garage.attributes.state,
      desiredState: garage.attributes.desiredState,
      garageType: model
    }

    // if the garage id is not in the ignore list in the homebridge config
    if (!this.ignoredDevices.includes(id)) {
      if (this.config.logLevel > 2)
        this.log(`Adding ${model} "${name}" (id=${id}, uuid=${uuid}) (${accessory.context.state} ${accessory.context.desiredState})`)

      this.addAccessory(accessory, type, model)
      this.setupGarage(accessory)

      // Set the initial garage state
      this.statGarageState(accessory, garage)
    }
  }

  setupGarage(accessory) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const model = accessory.context.garageType
    const [type, characteristic] = [
      Service.GarageDoorOpener,
      Characteristic.CurrentDoorState,
      Characteristic.TargetDoorState
     // Characteristic.ObstructionDetected
    ]
    if (!characteristic && this.config.logLevel > 1)
      throw new Error(`Unrecognized garage door opener ${accessory.context.accID}`)

    // Always reachable
    accessory.reachable = true

    // Setup HomeKit accessory information
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, id)

    // Setup event listeners

    accessory.on('identify', (paired, callback) => {
      if (this.config.logLevel > 2)
        this.log(`${name} identify requested, paired=${paired}`)

      callback()
    })

    const service = accessory.getService(type)

    service
      .getCharacteristic(Characteristic.CurrentDoorState)
      .on('get', callback => { callback(null, accessory.context.state) })

    service
      .getCharacteristic(Characteristic.TargetDoorState)
      .on('get', callback => callback(null, accessory.context.desiredState))
      .on('set', (value, callback) => this.changeGarageState(accessory, value, callback))
  }

  statGarageState(accessory, garage) {
    const id = accessory.context.accID
    const name = accessory.context.name
    const state = getGarageState(garage.attributes.state)
    const desiredState = getGarageState(garage.attributes.desiredState)

    if (state !== accessory.context.state) {
      if (this.config.logLevel > 2)
        this.log(`Updating garage ${name} (${id}), state=${state}, prev=${accessory.context.state}`)

      accessory.context.state = state
      accessory
        .getService(Service.GarageDoorOpener)
        .getCharacteristic(Characteristic.CurrentDoorState)
        .updateValue(state)
    }

    if (desiredState !== accessory.context.desiredState) {
      accessory.context.desiredState = desiredState
      accessory
        .getService(Service.GarageDoorOpener)
        .getCharacteristic(Characteristic.TargetDoorState)
        .updateValue(desiredState)
    }
  }

  /**
     * Change the physical state of a garage using the Alarm.com API.
     *
     * @param accessory  The lock to be changed.
     * @param {boolean} value  Value representing opened or closed states of the
     *   garage.
     * @param callback
     */

  changeGarageState(accessory, value, callback) {
    const id = accessory.context.accID
    let method
    const opts = {}

   const printval = value
   this.log(value)

    switch (value) {
      case Characteristic.TargetDoorState.OPEN:
        method = nodeADC.openGarage
        break
      case Characteristic.TargetDoorState.CLOSED:
        method = nodeADC.closeGarage
        break
      default:
        const msg = `Can't set garage to unknown value ${value}`
        if (this.config.logLevel > 1)
          this.log(msg)
        return callback(new Error(msg))
    }

    if (this.config.logLevel > 2)
      this.log(`Garage Door ${accessory.context.accID}, ${value})`)

    accessory.context.desiredState = value

    this.login()
      .then(res => method(id, res, opts)) // Usually 20-30 seconds
      .then(res => res.data)
      .then(garage => {
        this.statGarageState(accessory, garage)
      })
      .then(_ => callback())
      .catch(err => {
        this.log(`Error: Failed to change garage state: ${err.stack}`)
        this.refreshDevices()
        callback(err)
      })
  }

  // Accessory Methods /////////////////////////////////////////////////////////

  /**
   * Adds accessories tp the platform, homebridge and HomeKit.
   *
   * @param accessory  The accessory to be added from the platform.
   * @param type  The type of accessory.
   * @param model  The model of the accessory.
   */
  addAccessory(accessory, type, model) {
    const id = accessory.context.accID
    const name = accessory.context.name
    this.accessories[id] = accessory

    // Setup HomeKit service
    accessory.addService(type, name)

    // Register new accessory in HomeKit
    this.api.registerPlatformAccessories(PLUGIN_ID, PLUGIN_NAME, [accessory])
  }


  /**
   * Removes accessories from the platform, homebridge and HomeKit.
   *
   * @param accessory  The accessory to be removed from the platform.
   */
  removeAccessory(accessory) {
    if (!accessory) {
      return
    }

    const id = accessory.context.accID
    if (this.logLevel > 2) {
      this.log(`Removing ${accessory.context.name} (${id}) from HomeBridge`)
    }
    this.api.unregisterPlatformAccessories(PLUGIN_ID, PLUGIN_NAME, [accessory])
    delete this.accessories[id]
  }

  /**
   * Removes all accessories from the platform, homebridge and HomeKit.
   * Useful for updating homebridge with the list of accessories present.
   */
  removeAccessories() {
    this.accessories.forEach(id => this.removeAccessory(this.accessories[id]))
  }

  /**
   * Helper function to write JSON payloads to log files for debugging and
   * troubleshooting scenarios with specific alarm system setups.
   *
   * @param systemName {string}  The Name field defined in the config.
   * @param payloadLogPath {string}  The path where the files should go.
   * @param payloadLogName {string}  The name of the file (should end in .json).
   * @param payload {*}  The output to populate the log file with.
   */
  writePayload(payloadLogPath, payloadLogName, payload) {
    let now = new Date()
    let formatted_datetime = now.toLocaleString()
    let name = this.config.name
    let prefix = '[' + formatted_datetime + '] [' + name + '] '

    fs.mkdir(path.dirname(payloadLogPath), {
      recursive: true
    }, (err) => {
      if (err) {
        console.log(prefix + err)
      } else {
        fs.writeFile(payloadLogPath + payloadLogName, payload, {
          flag: 'w+'
        }, function (err) {
          if (err) {
            console.log(prefix + err)
          } else {
            console.log(prefix + payloadLogPath + payloadLogName + ' written')
          }
        });
      }
    });
  }

}

/**
 * Fetches all relationships for a system from Alarm.com
 *
 * @param res  Response object from login().
 * @returns {Promise<[(number | bigint), number, number, number, number, number,
 *   number, number, number, number]>}  See systemState.ts for return type.
 */
function fetchStateForAllSystems(res) {
  return Promise.all(res.systems.map(id => nodeADC.getCurrentState(id, res)))
}

/**
 * Maps an Alarm.com alarm panel state to its nodeADC counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {*}  The state as nodeADC defines it.
 */
function getPartitionState(state) {
  // console.log(`${sensor.attributes.description} Sensor (${sensor.id}) is ${sensor.attributes.stateText}.`)
  switch (state) {
    case nodeADC.SYSTEM_STATES.ARMED_STAY:
      return Characteristic.SecuritySystemCurrentState.STAY_ARM
    case nodeADC.SYSTEM_STATES.ARMED_AWAY:
      return Characteristic.SecuritySystemCurrentState.AWAY_ARM
    case nodeADC.SYSTEM_STATES.ARMED_NIGHT:
      return Characteristic.SecuritySystemCurrentState.NIGHT_ARM
    case nodeADC.SYSTEM_STATES.UNKNOWN:
    case nodeADC.SYSTEM_STATES.DISARMED:
    default:
      return Characteristic.SecuritySystemCurrentState.DISARMED
  }
}

/**
 * Maps an Alarm.com sensor state to its nodeADC counterpart.
 *
 * @param sensor  The state as defined by Alarm.com.
 * @returns {*}  The state as nodeADC defines it.
 */
function getSensorState(sensor) {
  // console.log(`${sensor.attributes.description} Sensor (${sensor.id}) is ${sensor.attributes.stateText}.`)
  switch (sensor.attributes.state) {
    case nodeADC.SENSOR_STATES.OPEN:
      return Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    case nodeADC.SENSOR_STATES.CLOSED:
      return Characteristic.ContactSensorState.CONTACT_DETECTED
    case nodeADC.SENSOR_STATES.ACTIVE:
      return Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
    case nodeADC.SENSOR_STATES.IDLE:
      return Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
    case nodeADC.SENSOR_STATES.WET:
      return Characteristic.LeakDetected.LEAK_DETECTED
    case nodeADC.SENSOR_STATES.DRY:
      return Characteristic.LeakDetected.LEAK_NOT_DETECTED
    default:
      return undefined
  }
}

/**
 * Maps an Alarm.com light state to its nodeADC counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as nodeADC defines it.
 */
function getLightState(state) {
  switch (state) {
    case nodeADC.LIGHT_STATES.OFF:
      return 0
    case nodeADC.LIGHT_STATES.ON:
      return 1
    default:
      return undefined
  }
}

/**
 * Maps an Alarm.com lock state to its nodeADC counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as nodeADC defines it.
 */
function getLockState(state) {
  switch (state) {
    case nodeADC.LOCK_STATES.UNSECURED:
      return Characteristic.LockCurrentState.UNSECURED
    case nodeADC.LOCK_STATES.SECURED:
      return Characteristic.LockCurrentState.SECURED
    default:
      return Characteristic.LockCurrentState.UNKNOWN
  }
}

/**
 * Maps an Alarm.com lock state to its nodeADC counterpart.
 *
 * @param state  The state as defined by Alarm.com.
 * @returns {number|*}  The state as nodeADC defines it.
 */
function getGarageState(state) {
  switch (state) {
    case nodeADC.GARAGE_STATES.OPEN:
      return Characteristic.GarageCurrentState.OPEN
    case nodeADC.GARAGE_STATES.CLOSED:
      return Characteristic.GARAGECurrentState.SECURED
    default:
      return Characteristic.GARAGECurrentState.UNKNOWN
  }
}

/**
 * Maps an Alarm.com sensor type to its nodeADC counterpart.
 *
 * @param sensor  The type as defined by Alarm.com.
 * @returns {array}  An array with details about its type as nodeADC defines it.
 */
function getSensorType(sensor) {
  const state = sensor.attributes.state

  switch (state) {
    case nodeADC.SENSOR_STATES.CLOSED:
    case nodeADC.SENSOR_STATES.OPEN:
      return [
        Service.ContactSensor,
        Characteristic.ContactSensorState,
        'Contact Sensor'
      ]
    case nodeADC.SENSOR_STATES.IDLE:
    case nodeADC.SENSOR_STATES.ACTIVE:
      return [
        Service.OccupancySensor,
        Characteristic.OccupancyDetected,
        'Occupancy Sensor'
      ]
    case nodeADC.SENSOR_STATES.DRY:
    case nodeADC.SENSOR_STATES.WET:
      return [
        Service.LeakSensor,
        Characteristic.LeakDetected,
        'Leak Sensor'
      ]
    default:
      return [undefined, undefined, undefined]
  }
}

/**
 * Maps an Alarm.com sensor model to its type represented in homebridge/homekit.
 *
 * @param model  The model as reported by Alarm.com.
 * @returns {array}  An array with homebridge service and characteristic types.
 */
function sensorModelToType(model) {
  switch (model) {
    case 'Contact Sensor':
      return [
        Service.ContactSensor,
        Characteristic.ContactSensorState
      ]
    case 'Occupancy Sensor':
      return [
        Service.OccupancySensor,
        Characteristic.OccupancyDetected
      ]
    case 'Leak Sensor':
      return [
        Service.LeakSensor,
        Characteristic.LeakDetected
      ]
    default:
      return [undefined, undefined]
  }
}
