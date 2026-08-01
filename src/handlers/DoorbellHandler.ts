import { CharacteristicGetCallback, PlatformAccessory } from 'homebridge';
import { CameraState, WebSocketEventTypes } from 'node-alarm-dot-com';
import { DoorbellContext, isDoorbell } from '../_models/Contexts';
import { BaseHandler } from './BaseHandler';
import { HandlerContext } from './HandlerContext';

type DoorbellCamera = {
  attributes: {
    deviceModel: string;
    isDoorbellCamera?: boolean;
  };
};

export function isSupportedDoorbellCamera(camera: DoorbellCamera, supportAnyDoorbellCamera: boolean): boolean {
  return (
    camera.attributes.deviceModel === 'ADC-VDB750' ||
    (supportAnyDoorbellCamera && camera.attributes.isDoorbellCamera === true)
  );
}

export class DoorbellHandler extends BaseHandler<DoorbellContext, CameraState, WebSocketEventTypes> {
  constructor(ctx: HandlerContext) {
    super(ctx);
  }

  add(camera: CameraState): void {
    const { api, log, ignoredDevices } = this.ctx;
    if (!isSupportedDoorbellCamera(camera, this.ctx.supportAnyDoorbellCamera)) {
      return;
    }

    const hap = api.hap;
    const id = camera.id;
    const model = camera.attributes.deviceModel;
    const name = camera.attributes.description;
    const accessory = this.createAccessory(id, name);

    accessory.context = {
      accID: id,
      name: name,
      model: model,
      isDoorbellCamera: camera.attributes.isDoorbellCamera,
      motionDetected: false,
      doorbellType: 'default'
    };

    if (!ignoredDevices.includes(id)) {
      log.info(`Adding ${model} "${name}" (id=${id}, uuid=${accessory.UUID})`);
      this.ctx.addAccessory(accessory, hap.Service.Doorbell, model);
      accessory.addService(hap.Service.MotionSensor);
      this.setup(accessory);
      this.stat(accessory, camera);
    }
  }

  override refresh(camera: CameraState): void {
    const accessory = this.ctx.accessories.find((a) => a.context.accID === camera.id);
    if (!isSupportedDoorbellCamera(camera, this.ctx.supportAnyDoorbellCamera)) {
      if (accessory && isDoorbell(accessory)) {
        this.ctx.removeAccessory(accessory);
      }
      return;
    }

    super.refresh(camera);
  }

  setup(accessory: PlatformAccessory<DoorbellContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const model = accessory.context.model;

    this.setAccessoryInfo(accessory, model);
    this.registerIdentify(accessory);

    const doorbellService = accessory.getService(hap.Service.Doorbell);
    if (doorbellService === undefined) {
      log.error(`Trouble getting Doorbell service for ${accessory.context.accID}`);
      return;
    }

    doorbellService
      .getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, null));

    const motionService = accessory.getService(hap.Service.MotionSensor);
    if (motionService === undefined) {
      log.error(`Trouble getting MotionSensor service for ${accessory.context.accID}`);
      return;
    }

    motionService
      .getCharacteristic(hap.Characteristic.MotionDetected)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.motionDetected));
  }

  stat(accessory: PlatformAccessory<DoorbellContext>, camera: CameraState): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    accessory.context.model = camera.attributes.deviceModel;
    accessory.context.isDoorbellCamera = camera.attributes.isDoorbellCamera;

    log.debug(`Polling doorbell ${name} (${id})`);

    if (accessory.context.motionDetected) {
      accessory.context.motionDetected = false;
      const motionService = accessory.getService(hap.Service.MotionSensor);
      motionService?.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(false);
    }
  }

  statFromWebSocket(accessory: PlatformAccessory<DoorbellContext>, eventType: WebSocketEventTypes): boolean {
    const camera = {
      attributes: {
        deviceModel: accessory.context.model,
        isDoorbellCamera: accessory.context.isDoorbellCamera
      }
    };
    if (!isSupportedDoorbellCamera(camera, this.ctx.supportAnyDoorbellCamera)) {
      return false;
    }

    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    if (eventType === WebSocketEventTypes.VideoCameraTriggered) {
      log.info(`Doorbell ring detected for ${name} (${id})`);
      const doorbellService = accessory.getService(hap.Service.Doorbell);
      doorbellService
        ?.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
        .updateValue(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
      return true;
    }

    if (
      eventType === WebSocketEventTypes.VideoAnalyticsDetection ||
      eventType === WebSocketEventTypes.VideoAnalytics2Detection
    ) {
      log.info(`Motion detected for doorbell ${name} (${id})`);
      accessory.context.motionDetected = true;
      const motionService = accessory.getService(hap.Service.MotionSensor);
      motionService?.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(true);

      setTimeout(() => {
        accessory.context.motionDetected = false;
        motionService?.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(false);
        log.debug(`Motion reset for doorbell ${name} (${id})`);
      }, 5000);

      return true;
    }

    return false;
  }
}
