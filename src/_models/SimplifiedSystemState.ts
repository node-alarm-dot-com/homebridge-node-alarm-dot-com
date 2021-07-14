import {
  GarageState,
  LightState,
  LockState,
  PartitionState,
  Relationships,
  SensorState,
  SystemAttributes
} from 'node-alarm-dot-com';

export interface SimplifiedSystemState {
  partitions: PartitionState[],
  sensors: SensorState[],
  lights: LightState[],
  locks: LockState[],
  garages: GarageState[],
}
