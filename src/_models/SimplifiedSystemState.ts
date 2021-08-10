import {
  GarageState,
  LightState,
  LockState,
  PartitionState,
  Relationships,
  SensorState,
  SystemAttributes
} from 'node-alarm-dot-com-2';

export interface SimplifiedSystemState {
  partitions: PartitionState[],
  sensors: SensorState[],
  lights: LightState[],
  locks: LockState[],
  garages: GarageState[],
}
