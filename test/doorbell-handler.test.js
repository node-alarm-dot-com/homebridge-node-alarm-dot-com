const assert = require('node:assert/strict');
const test = require('node:test');

const { DoorbellHandler, isSupportedDoorbellCamera } = require('../dist/handlers/DoorbellHandler');
const { WebSocketEventTypes } = require('node-alarm-dot-com');

function camera(deviceModel, isDoorbellCamera, id = 'camera-1') {
  return {
    id,
    attributes: {
      deviceModel,
      isDoorbellCamera
    }
  };
}

test('supports the ADC-VDB750 by default', () => {
  assert.equal(isSupportedDoorbellCamera(camera('ADC-VDB750', false), false), true);
});

test('does not expose other doorbell cameras unless explicitly enabled', () => {
  const otherDoorbell = camera('OTHER-DOORBELL', true);

  assert.equal(isSupportedDoorbellCamera(otherDoorbell, false), false);
  assert.equal(isSupportedDoorbellCamera(otherDoorbell, true), true);
});

test('does not expose a regular camera even when other doorbell models are enabled', () => {
  assert.equal(isSupportedDoorbellCamera(camera('ADC-OTHER-CAMERA', false), true), false);
});

test('registers a supported camera as a motion sensor without a Doorbell service', () => {
  const AccessoryInformation = Symbol('AccessoryInformation');
  const Doorbell = Symbol('Doorbell');
  const MotionSensor = Symbol('MotionSensor');
  const MotionDetected = Symbol('MotionDetected');
  const registeredServices = [];

  class Accessory {
    constructor(name, uuid) {
      this.displayName = name;
      this.UUID = uuid;
      this.context = {};
      this.services = new Map();
    }

    addService(service) {
      this.services.set(service, {
        getCharacteristic(characteristic) {
          assert.equal(characteristic, MotionDetected);
          return {
            on() {
              return this;
            },
            updateValue() {}
          };
        }
      });
    }

    getService(service) {
      if (service === AccessoryInformation) return undefined;
      return this.services.get(service);
    }

    on() {}
  }

  const handler = new DoorbellHandler({
    api: {
      hap: {
        uuid: { generate: (id) => `uuid:${id}` },
        Service: { AccessoryInformation, Doorbell, MotionSensor },
        Characteristic: { MotionDetected }
      },
      platformAccessory: Accessory
    },
    accessories: [],
    ignoredDevices: [],
    supportAnyDoorbellCamera: false,
    addAccessory(accessory, service) {
      registeredServices.push(service);
      accessory.addService(service);
    },
    log: {
      debug() {},
      error() {},
      info() {}
    }
  });

  handler.add({
    ...camera('ADC-VDB750', true),
    attributes: {
      deviceModel: 'ADC-VDB750',
      description: 'Front Door',
      isDoorbellCamera: true
    }
  });

  assert.deepEqual(registeredServices, [MotionSensor]);
  assert.equal(registeredServices.includes(Doorbell), false);
});

test('removes an unsupported doorbell accessory restored from cache', () => {
  const cachedAccessory = {
    context: {
      accID: 'camera-1',
      doorbellType: 'default'
    }
  };
  const removed = [];
  const handler = new DoorbellHandler({
    accessories: [cachedAccessory],
    ignoredDevices: [],
    supportAnyDoorbellCamera: false,
    removeAccessory(accessory) {
      removed.push(accessory);
    }
  });

  handler.refresh(camera('ADC-OTHER-CAMERA', false));

  assert.deepEqual(removed, [cachedAccessory]);
});

test('ignores events from an unsupported doorbell accessory restored from cache', () => {
  const cachedAccessory = {
    context: {
      accID: 'camera-1',
      model: 'ADC-OTHER-CAMERA',
      doorbellType: 'default'
    }
  };
  const handler = new DoorbellHandler({
    supportAnyDoorbellCamera: false
  });

  assert.equal(handler.statFromWebSocket(cachedAccessory, 1), false);
});

test('ignores camera-triggered events instead of generating a doorbell ring', () => {
  const accessory = {
    context: {
      accID: 'camera-1',
      model: 'ADC-VDB750',
      doorbellType: 'default'
    }
  };
  const handler = new DoorbellHandler({
    supportAnyDoorbellCamera: false
  });

  assert.equal(handler.statFromWebSocket(accessory, WebSocketEventTypes.VideoCameraTriggered), false);
});

test('removes a legacy Doorbell service while restoring the motion sensor', () => {
  const AccessoryInformation = Symbol('AccessoryInformation');
  const Doorbell = Symbol('Doorbell');
  const MotionSensor = Symbol('MotionSensor');
  const MotionDetected = Symbol('MotionDetected');
  const doorbellService = {};
  const motionCharacteristic = {
    on() {
      return this;
    }
  };
  const motionService = {
    getCharacteristic(characteristic) {
      assert.equal(characteristic, MotionDetected);
      return motionCharacteristic;
    }
  };
  const removed = [];
  const accessory = {
    context: {
      accID: 'camera-1',
      name: 'Front Door',
      model: 'ADC-VDB750',
      motionDetected: false,
      doorbellType: 'default'
    },
    getService(service) {
      if (service === Doorbell) return doorbellService;
      if (service === MotionSensor) return motionService;
      if (service === AccessoryInformation) return undefined;
      throw new Error('Unexpected service');
    },
    removeService(service) {
      removed.push(service);
    },
    on() {}
  };
  const handler = new DoorbellHandler({
    api: {
      hap: {
        Service: { AccessoryInformation, Doorbell, MotionSensor },
        Characteristic: { MotionDetected }
      }
    },
    log: {
      debug() {},
      error() {},
      info() {}
    },
    supportAnyDoorbellCamera: false
  });

  handler.setup(accessory);

  assert.deepEqual(removed, [doorbellService]);
});
