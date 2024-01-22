import { CharacteristicValue, PlatformAccessory } from 'homebridge';
import { SensorType } from 'node-alarm-dot-com';

/**
 * This is the information that is shared amongst all devices.
 */
export interface BaseContext {
  /**
   * accID is the ID assigned from Alarm.com.
   */
  accID: string;
  /**
   * name is the description set with Alarm.com.
   */
  name: string;
}

/**
 * Represents custom information stored in the accessory context of a sensor
 */
export interface SensorContext extends BaseContext {
  state: CharacteristicValue;
  batteryLow: boolean;
  /**
   * SensorType is a string which was used pre v1.8.0 to track the sensor type.
   * @deprecated Use the type property for a better representation of the type.
   */
  sensorType: string;
  /**
   * Type refers to the type of sensor as told by the Alarm.com API. The previous property, sensorType, was best-guess
   * and was sometimes reporting the wrong sensor type.
   */
  type: SensorType;
}

//Light
export interface LightContext extends BaseContext {
  state: CharacteristicValue;
  desiredState: CharacteristicValue;
  isDimmer: boolean;
  lightLevel: number;
  lightType: string;
}

//Partition
export interface PartitionContext extends BaseContext {
  state: CharacteristicValue;
  desiredState: CharacteristicValue;
  statusFault: boolean;
  partitionType: 'default';
}

//Lock
export interface LockContext extends BaseContext {
  accID: string;
  name: string;
  state: CharacteristicValue;
  desiredState: CharacteristicValue;
  lockType: string;
}

//Garage
export interface GarageContext extends BaseContext {
  accID: string;
  name: string;
  state: CharacteristicValue;
  desiredState: CharacteristicValue;
  garageType: string;
}

//Thermostat
export interface ThermostatContext extends BaseContext {
  accID: string,
  name: string,
  state: CharacteristicValue,
  desiredState: CharacteristicValue,
  currentTemperature: CharacteristicValue,
  targetTemperature: CharacteristicValue,
  thermostatType: string,
  supportsHumidity: boolean,
  humidityLevel: CharacteristicValue,
}

// Region: Function Casts


export function isPartition(accessory: PlatformAccessory): accessory is PlatformAccessory<PartitionContext> {
  return (accessory as PlatformAccessory<PartitionContext>).context.partitionType !== undefined;
}
export function isSensor(accessory: PlatformAccessory): accessory is PlatformAccessory<SensorContext> {
  return (accessory as PlatformAccessory<SensorContext>).context.type !== undefined;
}
export function isLock(accessory: PlatformAccessory): accessory is PlatformAccessory<LockContext> {
  return (accessory as PlatformAccessory<LockContext>).context.lockType !== undefined;
}
export function isLight(accessory: PlatformAccessory): accessory is PlatformAccessory<LightContext> {
  return (accessory as PlatformAccessory<LightContext>).context.isDimmer !== undefined;
}
export function isGarage(accessory: PlatformAccessory): accessory is PlatformAccessory<GarageContext> {
  return (accessory as PlatformAccessory<GarageContext>).context.garageType !== undefined;
}
export function isThermostat(accessory: PlatformAccessory): accessory is PlatformAccessory<ThermostatContext> {
  return (accessory as PlatformAccessory<ThermostatContext>).context.thermostatType !== undefined;
}

// End Region
