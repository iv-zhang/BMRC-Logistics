import assert from 'node:assert/strict';
import { isAedDevice, isEpinephrine, criticalKindOf } from '../app/lib/statpack-critical';

assert.equal(isAedDevice({ assetCategory: 'AED', name: 'Philips FRx' }), true, 'category wins');
assert.equal(isAedDevice({ name: 'AED (Philips FRx)' }), true);
assert.equal(isAedDevice({ name: 'AED Pads' }), false);
assert.equal(isAedDevice({ name: 'AED Pad - adult' }), false);
assert.equal(isAedDevice({ name: 'AED Battery' }), false);
assert.equal(isAedDevice({ name: 'AED Trainer' }), false);
assert.equal(isAedDevice({ name: 'AED', isTrainer: true }), false);
assert.equal(isAedDevice({ name: 'Gauze' }), false);
assert.equal(isAedDevice(undefined), false);

assert.equal(isEpinephrine({ name: 'Epinephrine 1mg/mL (1:1000)' }), true);
assert.equal(isEpinephrine({ name: 'EpiPen' }), true);
assert.equal(isEpinephrine({ name: 'Gauze' }), false);
assert.equal(isEpinephrine(null), false);

assert.equal(criticalKindOf({ name: 'Epinephrine' }), 'epinephrine');
console.log('statpack-critical: ok');
