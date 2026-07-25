import { CharacteristicGetCallback, CharacteristicValue, HAP, PlatformAccessory, Service } from 'homebridge';
import { SensorState, SensorType, WebSocketEventTypes } from 'node-alarm-dot-com';
import { SENSOR_STATES } from 'node-alarm-dot-com/dist/_models/States';
import { SensorContext } from '../_models/Contexts';
import { BaseHandler } from './BaseHandler';
import { HandlerContext } from './HandlerContext';

export class SensorHandler extends BaseHandler<SensorContext, SensorState, WebSocketEventTypes> {
  constructor(ctx: HandlerContext) {
    super(ctx);
  }

  add(sensor: SensorState): void {
    const { api, log, ignoredDevices } = this.ctx;
    const hap = api.hap;
    const id = sensor.id;
    const [type, , model] = getSensorType(sensor, hap);
    if (type === undefined) {
      log.warn(
        `Warning: Sensor ${sensor.attributes.description} has unknown state ${sensor.attributes.state} (${sensor.id})`
      );
      return;
    }

    const name = sensor.attributes.description;
    const accessory = this.createAccessory(id, name);

    accessory.context = {
      accID: id,
      name: name,
      state: SENSOR_STATES.UNKNOWN,
      batteryLow: false,
      sensorType: model,
      type: sensor.attributes.deviceType
    };

    if (!ignoredDevices.includes(id)) {
      log.info(`Adding ${model} "${name}" (id=${id}, uuid=${accessory.UUID})`);
      this.ctx.addAccessory(accessory, type, model);
      this.setup(accessory);
      this.stat(accessory, sensor);
    }
  }

  setup(accessory: PlatformAccessory<SensorContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const model = accessory.context.sensorType;
    const [type, characteristic] = sensorModelToType(model, hap);
    if (!characteristic) {
      log.error(`Unrecognized sensor ${id}`);
      return;
    }

    this.setAccessoryInfo(accessory, model);
    this.registerIdentify(accessory);

    const service = accessory.getService(type);
    if (service === undefined) {
      log.error(`Trouble getting service ${type} for device with id ${id}`);
      return;
    }

    service
      .getCharacteristic(characteristic)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.state));

    service
      .getCharacteristic(hap.Characteristic.StatusLowBattery)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.batteryLow));
  }

  stat(accessory: PlatformAccessory<SensorContext>, sensor: SensorState): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;
    const state = getSensorState(sensor, hap);
    const batteryLow = Boolean(sensor.attributes.lowBattery || sensor.attributes.criticalBattery);
    const [type, characteristic, model] = getSensorType(sensor, hap);

    const service = accessory.getService(type);
    if (service === undefined) {
      log.error(`Error getting service for ${type} device with id ${id}`);
      return;
    }

    if (state !== accessory.context.state) {
      log.info(`Updating sensor ${name} (${model}) (${id}), state=${state}, prev=${accessory.context.state}`);
      accessory.context.state = state;
      service.getCharacteristic(characteristic).updateValue(state);
    }

    if (batteryLow !== accessory.context.batteryLow) {
      log.info(`Updating sensor ${name} (${id}), batteryLow=${batteryLow}, prev=${accessory.context.batteryLow}`);
      accessory.context.batteryLow = batteryLow;
      service.getCharacteristic(hap.Characteristic.StatusLowBattery).updateValue(batteryLow);
    }
  }

  statFromWebSocket(accessory: PlatformAccessory<SensorContext>, eventType: WebSocketEventTypes): boolean {
    const { api } = this.ctx;
    const hap = api.hap;

    const contact = accessory.getService(hap.Service.ContactSensor);
    if (contact) {
      switch (eventType) {
        case WebSocketEventTypes.Opened:
        case WebSocketEventTypes.DoorLeftOpen:
          this.updateSensorCharacteristic(
            accessory,
            contact,
            hap.Characteristic.ContactSensorState,
            hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          );
          return true;
        case WebSocketEventTypes.Closed:
        case WebSocketEventTypes.DoorLeftOpenRestoral:
        case WebSocketEventTypes.OpenedClosed:
          // OpenedClosed is a completed open→close cycle; final state is closed.
          this.updateSensorCharacteristic(
            accessory,
            contact,
            hap.Characteristic.ContactSensorState,
            hap.Characteristic.ContactSensorState.CONTACT_DETECTED
          );
          return true;
        default:
          return false;
      }
    }

    // Alarm.com reuses Opened/Closed-style events across sensor classes.
    // OpenedClosed is a completed cycle → settle on the idle/clear state.
    const isActive = eventType === WebSocketEventTypes.Opened || eventType === WebSocketEventTypes.DoorLeftOpen;
    const isIdle =
      eventType === WebSocketEventTypes.Closed ||
      eventType === WebSocketEventTypes.DoorLeftOpenRestoral ||
      eventType === WebSocketEventTypes.OpenedClosed;

    if (!isActive && !isIdle) {
      // Tamper/Bypass/etc. need REST reconciliation.
      return false;
    }

    const motion = accessory.getService(hap.Service.MotionSensor);
    if (motion) {
      this.updateSensorCharacteristic(accessory, motion, hap.Characteristic.MotionDetected, isActive);
      return true;
    }

    const occupancy = accessory.getService(hap.Service.OccupancySensor);
    if (occupancy) {
      this.updateSensorCharacteristic(
        accessory,
        occupancy,
        hap.Characteristic.OccupancyDetected,
        isActive
          ? hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
      );
      return true;
    }

    const leak = accessory.getService(hap.Service.LeakSensor);
    if (leak) {
      this.updateSensorCharacteristic(
        accessory,
        leak,
        hap.Characteristic.LeakDetected,
        isActive ? hap.Characteristic.LeakDetected.LEAK_DETECTED : hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED
      );
      return true;
    }

    const smoke = accessory.getService(hap.Service.SmokeSensor);
    if (smoke) {
      this.updateSensorCharacteristic(
        accessory,
        smoke,
        hap.Characteristic.SmokeDetected,
        isActive ? hap.Characteristic.SmokeDetected.SMOKE_DETECTED : hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
      );
      return true;
    }

    const co = accessory.getService(hap.Service.CarbonMonoxideSensor);
    if (co) {
      this.updateSensorCharacteristic(
        accessory,
        co,
        hap.Characteristic.CarbonMonoxideDetected,
        isActive
          ? hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
      );
      return true;
    }

    return false;
  }

  private updateSensorCharacteristic(
    accessory: PlatformAccessory<SensorContext>,
    service: Service,
    // Homebridge overloaded getCharacteristic typing + noUncheckedIndexedAccess
    // make Parameters<> awkward; handlers already pass concrete Characteristic classes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    characteristic: any,
    state: CharacteristicValue
  ): void {
    const { log } = this.ctx;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    if (state !== accessory.context.state) {
      log.info(`Updating sensor ${name} (${id}), state=${state}, prev=${accessory.context.state}`);
      accessory.context.state = state;
      service.getCharacteristic(characteristic).updateValue(state);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSensorType(sensor: SensorState, hap: HAP): Array<any> {
  const state = sensor.attributes.state;
  const type = sensor.attributes.deviceType;

  switch (type) {
    case SensorType.Motion_Sensor:
      return [hap.Service.MotionSensor, hap.Characteristic.MotionDetected, 'Motion Sensor'];
    case SensorType.Smoke_Detector:
    case SensorType.Heat_Detector:
      return [hap.Service.SmokeSensor, hap.Characteristic.SmokeDetected, 'Heat Sensor'];
    case SensorType.CO_Detector:
      return [hap.Service.CarbonMonoxideSensor, hap.Characteristic.CarbonMonoxideDetected, 'Carbon Monoxide Detector'];
    case SensorType.Fob:
      return [hap.Service.AccessControl, hap.Characteristic.RemoteKey, 'Key fob'];
    case SensorType.Water_Sensor:
      return [hap.Service.LeakSensor, hap.Characteristic.LeakDetected, 'Water Sensor'];
    case SensorType.Contact_Sensor:
      return [hap.Service.ContactSensor, hap.Characteristic.ContactSensorState, 'Contact Sensor'];
    default:
      switch (state) {
        case SENSOR_STATES.CLOSED:
        case SENSOR_STATES.OPEN:
          return [hap.Service.ContactSensor, hap.Characteristic.ContactSensorState, 'Contact Sensor'];
        case SENSOR_STATES.IDLE:
        case SENSOR_STATES.ACTIVE:
          return [hap.Service.OccupancySensor, hap.Characteristic.OccupancyDetected, 'Occupancy Sensor'];
        case SENSOR_STATES.DRY:
        case SENSOR_STATES.WET:
          return [hap.Service.LeakSensor, hap.Characteristic.LeakDetected, 'Leak Sensor'];
        default:
          return [undefined, undefined, undefined];
      }
  }
}

function getSensorState(sensor: SensorState, hap: HAP): CharacteristicValue {
  if (sensor.attributes.deviceType == SensorType.Heat_Detector) {
    return sensor.attributes.state === 0
      ? hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
      : hap.Characteristic.SmokeDetected.SMOKE_DETECTED;
  }

  if (sensor.attributes.deviceType == SensorType.Glass_Break) {
    return sensor.attributes.openClosedStatus === 2
      ? hap.Characteristic.ContactSensorState.CONTACT_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  switch (sensor.attributes.state) {
    case SENSOR_STATES.OPEN:
      return hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    case SENSOR_STATES.CLOSED:
      return hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
    case SENSOR_STATES.ACTIVE:
      return hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    case SENSOR_STATES.IDLE:
      return hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
    case SENSOR_STATES.WET:
      return hap.Characteristic.LeakDetected.LEAK_DETECTED;
    case SENSOR_STATES.DRY:
      return hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    case SENSOR_STATES.UNKNOWN:
      return hap.Characteristic.StatusFault.GENERAL_FAULT;
    default:
      return -1;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sensorModelToType(model: string, hap: HAP): Array<any> {
  switch (model) {
    case 'Contact Sensor':
      return [hap.Service.ContactSensor, hap.Characteristic.ContactSensorState];
    case 'Occupancy Sensor':
      return [hap.Service.OccupancySensor, hap.Characteristic.OccupancyDetected];
    case 'Leak Sensor':
      return [hap.Service.LeakSensor, hap.Characteristic.LeakDetected];
    case 'Key fob':
      return [hap.Service.AccessControl, hap.Characteristic.RemoteKey];
    case 'Carbon Monoxide Detector':
      return [hap.Service.CarbonMonoxideSensor, hap.Characteristic.CarbonMonoxideDetected];
    case 'Smoke Detector':
    case 'Heat Sensor':
      return [hap.Service.SmokeSensor, hap.Characteristic.SmokeDetected];
    case 'Motion Sensor':
      return [hap.Service.MotionSensor, hap.Characteristic.MotionDetected];
    default:
      return [undefined, undefined];
  }
}
