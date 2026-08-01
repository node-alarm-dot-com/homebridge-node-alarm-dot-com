const assert = require('node:assert/strict');
const test = require('node:test');

const { DoorbellHandler, isSupportedDoorbellCamera } = require('../dist/handlers/DoorbellHandler');

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
