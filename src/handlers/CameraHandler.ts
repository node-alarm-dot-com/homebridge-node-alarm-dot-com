import { CharacteristicGetCallback, PlatformAccessory } from 'homebridge';
import { CameraState, WebSocketEventTypes } from 'node-alarm-dot-com';
import { CameraContext } from '../_models/Contexts';
import { BaseHandler } from './BaseHandler';
import { HandlerContext } from './HandlerContext';

export class CameraHandler extends BaseHandler<CameraContext, CameraState, WebSocketEventTypes> {
  constructor(ctx: HandlerContext) {
    super(ctx);
  }

  add(camera: CameraState): void {
    const { api, log, ignoredDevices } = this.ctx;
    const hap = api.hap;
    const id = camera.id;
    const model = camera.attributes.deviceModel;
    const name = camera.attributes.description;
    const isDoorbell = camera.attributes.isDoorbellCamera;
    const accessory = this.createAccessory(id, name);

    accessory.context = {
      accID: id,
      name: name,
      model: model,
      motionDetected: false,
      isDoorbell: isDoorbell,
      cameraType: 'default'
    };

    if (!ignoredDevices.includes(id)) {
      log.info(`Adding ${model} "${name}" (id=${id}, uuid=${accessory.UUID})`);
      if (isDoorbell) {
        this.ctx.addAccessory(accessory, hap.Service.Doorbell, model);
        accessory.addService(hap.Service.MotionSensor);
      } else {
        this.ctx.addAccessory(accessory, hap.Service.MotionSensor, model);
      }
      this.setup(accessory);
      this.stat(accessory, camera);
    }
  }

  setup(accessory: PlatformAccessory<CameraContext>): void {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const model = accessory.context.model;

    this.setAccessoryInfo(accessory, model);
    this.registerIdentify(accessory);

    if (accessory.context.isDoorbell) {
      const doorbellService = accessory.getService(hap.Service.Doorbell);
      if (doorbellService === undefined) {
        log.error(`Trouble getting Doorbell service for ${accessory.context.accID}`);
        return;
      }

      doorbellService.setPrimaryService(true);

      doorbellService
        .getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
        .on('get', (callback: CharacteristicGetCallback) => callback(null, null));
    }

    const motionService = accessory.getService(hap.Service.MotionSensor);
    if (motionService === undefined) {
      log.error(`Trouble getting MotionSensor service for ${accessory.context.accID}`);
      return;
    }

    motionService
      .getCharacteristic(hap.Characteristic.MotionDetected)
      .on('get', (callback: CharacteristicGetCallback) => callback(null, accessory.context.motionDetected));
  }

  /**
   * Cameras added by older plugin versions always got a physical Doorbell service,
   * so its mere presence can't be used to tell doorbells and plain cameras apart.
   * Reconciling against the live isDoorbellCamera flag fixes up cached accessories
   * and self-heals if Alarm.com's flag for a device ever changes.
   */
  private reconcileDoorbell(accessory: PlatformAccessory<CameraContext>, camera: CameraState): void {
    const { api } = this.ctx;
    const hap = api.hap;
    const isDoorbell = camera.attributes.isDoorbellCamera;

    if (accessory.context.isDoorbell === isDoorbell) {
      return;
    }

    accessory.context.isDoorbell = isDoorbell;

    if (isDoorbell) {
      if (accessory.getService(hap.Service.Doorbell) === undefined) {
        accessory.addService(hap.Service.Doorbell);
      }
    } else {
      const doorbellService = accessory.getService(hap.Service.Doorbell);
      if (doorbellService !== undefined) {
        accessory.removeService(doorbellService);
      }
    }

    this.setup(accessory);
  }

  stat(accessory: PlatformAccessory<CameraContext>, camera: CameraState): void {
    this.reconcileDoorbell(accessory, camera);

    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    log.debug(`Polling camera ${name} (${id})`);

    if (accessory.context.motionDetected) {
      accessory.context.motionDetected = false;
      const motionService = accessory.getService(hap.Service.MotionSensor);
      motionService?.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(false);
    }
  }

  statFromWebSocket(accessory: PlatformAccessory<CameraContext>, eventType: WebSocketEventTypes): boolean {
    const { api, log } = this.ctx;
    const hap = api.hap;
    const id = accessory.context.accID;
    const name = accessory.context.name;

    if (eventType === WebSocketEventTypes.VideoCameraTriggered) {
      if (!accessory.context.isDoorbell) {
        log.debug(`Ignoring ring event for non-doorbell camera ${name} (${id})`);
        return false;
      }

      log.info(`Camera ring detected for ${name} (${id})`);
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
      log.info(`Motion detected for camera ${name} (${id})`);
      accessory.context.motionDetected = true;
      const motionService = accessory.getService(hap.Service.MotionSensor);
      motionService?.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(true);

      setTimeout(() => {
        accessory.context.motionDetected = false;
        motionService?.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(false);
        log.debug(`Motion reset for camera ${name} (${id})`);
      }, 5000);

      return true;
    }

    return false;
  }
}
