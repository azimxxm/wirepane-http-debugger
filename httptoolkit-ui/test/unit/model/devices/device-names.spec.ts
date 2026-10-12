import { expect } from '../../../test-setup';

import {
    DEVICE_NAMES_KEY,
    MAX_DEVICE_NAME_LENGTH,
    cleanDeviceName,
    loadDeviceNames,
    saveDeviceNames
} from '../../../../src/model/devices/device-names';

import { MemoryStorage } from './device-test-helpers';

const brokenStorage = {
    getItem(): string | null { throw new Error('Storage is disabled'); },
    setItem(): void { throw new Error('Storage is full'); }
};

describe('Device names', () => {

    it('saves names as JSON and loads them back', () => {
        const storage = new MemoryStorage();
        saveDeviceNames(new Map([['192.168.0.23', "Azim's iPhone"], ['this-machine', 'Work Mac']]), storage);

        expect(JSON.parse(storage.items.get(DEVICE_NAMES_KEY)!)).to.deep.equal({
            '192.168.0.23': "Azim's iPhone",
            'this-machine': 'Work Mac'
        });
        expect([...loadDeviceNames(storage)]).to.deep.equal([
            ['192.168.0.23', "Azim's iPhone"],
            ['this-machine', 'Work Mac']
        ]);
    });

    it('starts empty without saved names', () => {
        expect(loadDeviceNames(new MemoryStorage()).size).to.equal(0);
    });

    it('ignores saved data it cannot use', () => {
        const storage = new MemoryStorage();

        storage.setItem(DEVICE_NAMES_KEY, '{not json');
        expect(loadDeviceNames(storage).size).to.equal(0);

        storage.setItem(DEVICE_NAMES_KEY, '["a list"]');
        expect(loadDeviceNames(storage).size).to.equal(0);

        storage.setItem(DEVICE_NAMES_KEY, JSON.stringify({ a: 'Kept', b: 42, c: '   ' }));
        expect([...loadDeviceNames(storage)]).to.deep.equal([['a', 'Kept']]);
    });

    it("keeps working when storage can't be used", () => {
        expect(loadDeviceNames(brokenStorage).size).to.equal(0);
        expect(() => saveDeviceNames(new Map([['a', 'Name']]), brokenStorage)).not.to.throw();
    });

    it('tidies names up', () => {
        expect(cleanDeviceName('  Test   iPhone \n')).to.equal('Test iPhone');
        expect(cleanDeviceName('x'.repeat(200))).to.have.length(MAX_DEVICE_NAME_LENGTH);
    });
});
