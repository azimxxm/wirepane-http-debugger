import { expect } from '../../../test-setup';

import { VpnConditions } from '../../../../src/model/interception/vpn-network';
import {
    CONDITIONS_FIELDS,
    CONDITIONS_PRESETS,
    ConditionsDevice,
    MAX_JITTER_MS,
    MAX_KBPS,
    MAX_LATENCY_MS,
    NO_CONDITIONS,
    countActive,
    describeConditions,
    describePreset,
    findPreset,
    formatBandwidth,
    formatLoss,
    isOff,
    nameConditions,
    parseConditionsFields,
    pickDefaultDevice,
    sameConditions,
    toFormFields
} from '../../../../src/components/network/conditions-model';

const preset = (id: string) => CONDITIONS_PRESETS.find((candidate) => candidate.id === id)!;

describe('Network conditions model', () => {

    describe('presets', () => {
        it('offers Off, 3G, Edge, LTE, Lossy Wi-Fi and Offline, in this order', () => {
            expect(CONDITIONS_PRESETS.map((candidate) => candidate.label)).to.deep.equal([
                'Off', '3G', 'Edge', 'LTE', 'Lossy Wi-Fi', 'Offline'
            ]);
        });

        it('has the numbers the plan names', () => {
            expect(preset('off').conditions).to.equal(null);
            expect(preset('3g').conditions).to.deep.equal(
                { latencyMs: 200, jitterMs: 0, downKbps: 750, upKbps: 250, lossPct: 0 }
            );
            expect(preset('edge').conditions).to.deep.equal(
                { latencyMs: 400, jitterMs: 0, downKbps: 240, upKbps: 200, lossPct: 0 }
            );
            expect(preset('lte').conditions).to.deep.equal(
                { latencyMs: 50, jitterMs: 0, downKbps: 12_000, upKbps: 5_000, lossPct: 0 }
            );
            expect(preset('lossy-wifi').conditions).to.deep.equal(
                { latencyMs: 40, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 5 }
            );
            expect(preset('offline').conditions).to.deep.equal(
                { latencyMs: 0, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 100 }
            );
        });

        it('has presets that all pass the same checks as typed-in values', () => {
            CONDITIONS_PRESETS.forEach((candidate) => {
                const parsed = parseConditionsFields(toFormFields(candidate.conditions));
                expect(parsed.ok, candidate.label).to.equal(true);
            });
        });

        it('says what each preset does in one line', () => {
            expect(describePreset(preset('off'))).to.equal('Normal network');
            expect(describePreset(preset('3g'))).to.equal('750 kbps down, 250 kbps up, 200 ms latency');
            expect(describePreset(preset('lte'))).to.equal('12 Mbps down, 5 Mbps up, 50 ms latency');
            expect(describePreset(preset('lossy-wifi'))).to.equal('40 ms latency, 5% packet loss');
            expect(describePreset(preset('offline'))).to.equal('All packets are dropped');
        });
    });

    describe('telling whether conditions are on', () => {
        it('treats nothing and all zeros as off', () => {
            expect(isOff(null)).to.equal(true);
            expect(isOff(undefined)).to.equal(true);
            expect(isOff(NO_CONDITIONS)).to.equal(true);
        });

        it('treats any limit as on', () => {
            const fields: Array<keyof VpnConditions> = ['latencyMs', 'jitterMs', 'downKbps', 'upKbps', 'lossPct'];
            fields.forEach((field) => {
                expect(isOff({ ...NO_CONDITIONS, [field]: 1 }), field).to.equal(false);
            });
        });

        it('compares conditions by what they do', () => {
            expect(sameConditions(null, NO_CONDITIONS)).to.equal(true);
            expect(sameConditions(undefined, null)).to.equal(true);
            expect(sameConditions(preset('3g').conditions, { ...preset('3g').conditions! })).to.equal(true);
            expect(sameConditions(preset('3g').conditions, preset('edge').conditions)).to.equal(false);
            expect(sameConditions(preset('3g').conditions, null)).to.equal(false);
        });

        it('finds the preset that matches, and none for custom numbers', () => {
            expect(findPreset(null)?.id).to.equal('off');
            expect(findPreset(preset('edge').conditions)?.id).to.equal('edge');
            expect(findPreset({ ...preset('edge').conditions!, latencyMs: 401 })).to.equal(undefined);
        });

        it('names the conditions', () => {
            expect(nameConditions(null)).to.equal('Off');
            expect(nameConditions(preset('lte').conditions)).to.equal('LTE');
            expect(nameConditions({ ...NO_CONDITIONS, latencyMs: 123 })).to.equal('Custom');
        });
    });

    describe('describing numbers', () => {
        it('formats bandwidth', () => {
            expect(formatBandwidth(0)).to.equal('no limit');
            expect(formatBandwidth(750)).to.equal('750 kbps');
            expect(formatBandwidth(999)).to.equal('999 kbps');
            expect(formatBandwidth(1000)).to.equal('1 Mbps');
            expect(formatBandwidth(1500)).to.equal('1.5 Mbps');
            expect(formatBandwidth(12_000)).to.equal('12 Mbps');
            expect(formatBandwidth(1234)).to.equal('1.23 Mbps');
        });

        it('formats loss', () => {
            expect(formatLoss(5)).to.equal('5%');
            expect(formatLoss(0.5)).to.equal('0.5%');
            expect(formatLoss(12.345)).to.equal('12.35%');
        });

        it('describes conditions and leaves out what is off', () => {
            expect(describeConditions(null)).to.equal('No limits');
            expect(describeConditions({ ...NO_CONDITIONS, downKbps: 2000 })).to.equal('2 Mbps down');
            expect(describeConditions({ ...NO_CONDITIONS, upKbps: 64 })).to.equal('64 kbps up');
            expect(describeConditions({ ...NO_CONDITIONS, latencyMs: 80, jitterMs: 20 }))
                .to.equal('80 ms latency ± 20 ms jitter');
            expect(describeConditions({ latencyMs: 100, jitterMs: 0, downKbps: 500, upKbps: 0, lossPct: 2.5 }))
                .to.equal('500 kbps down, 100 ms latency, 2.5% packet loss');
        });
    });

    describe('reading the fields', () => {
        const fields = (overrides: Partial<{ [field: string]: string }> = {}) => ({
            ...toFormFields(null),
            ...overrides
        });

        const parse = (overrides: Partial<{ [field: string]: string }>) => {
            const result = parseConditionsFields(fields(overrides));
            if (!result.ok) throw new Error(`Expected valid fields, got ${JSON.stringify(result.errors)}`);
            return result.conditions;
        };

        const errorsOf = (overrides: Partial<{ [field: string]: string }>) => {
            const result = parseConditionsFields(fields(overrides));
            if (result.ok) throw new Error('Expected errors');
            return result.errors;
        };

        it('starts the form from the conditions, with zeros for none', () => {
            expect(toFormFields(null)).to.deep.equal(
                { latencyMs: '0', jitterMs: '0', downKbps: '0', upKbps: '0', lossPct: '0' }
            );
            expect(toFormFields(preset('3g').conditions)).to.deep.equal(
                { latencyMs: '200', jitterMs: '0', downKbps: '750', upKbps: '250', lossPct: '0' }
            );
        });

        it('turns the fields back into the same conditions', () => {
            CONDITIONS_PRESETS.forEach((candidate) => {
                expect(parse(toFormFields(candidate.conditions))).to.deep.equal(
                    candidate.conditions ?? NO_CONDITIONS
                );
            });
        });

        it('reads numbers with spaces around them', () => {
            expect(parse({ latencyMs: ' 150 ', downKbps: '\t900' })).to.deep.equal(
                { ...NO_CONDITIONS, latencyMs: 150, downKbps: 900 }
            );
        });

        it('reads an empty field as none', () => {
            expect(parse({ latencyMs: '', jitterMs: '   ', downKbps: '' })).to.deep.equal(NO_CONDITIONS);
        });

        it('allows decimals in the loss only', () => {
            expect(parse({ lossPct: '2.5' }).lossPct).to.equal(2.5);
            expect(parse({ lossPct: '.5' }).lossPct).to.equal(0.5);
            expect(parse({ lossPct: '100' }).lossPct).to.equal(100);
            expect(parse({ lossPct: '0.125' }).lossPct).to.equal(0.13);

            expect(errorsOf({ latencyMs: '1.5' }).latencyMs).to.equal('Use a whole number');
            expect(errorsOf({ downKbps: '10.5' }).downKbps).to.equal('Use a whole number');
        });

        it('rejects text that is not a plain number', () => {
            ['abc', '12 ms', '1e3', '0x10', 'Infinity', 'NaN', '1,5', '--1', '1.2.3'].forEach((text) => {
                expect(errorsOf({ latencyMs: text }).latencyMs, text).to.equal('Enter a number');
            });
        });

        it('rejects negative numbers', () => {
            expect(errorsOf({ latencyMs: '-1' }).latencyMs).to.equal('Can\'t be negative');
            expect(errorsOf({ lossPct: '-0.5' }).lossPct).to.equal('Can\'t be negative');
        });

        it('rejects numbers over the limits, and takes the limits themselves', () => {
            expect(errorsOf({ latencyMs: String(MAX_LATENCY_MS + 1) }).latencyMs).to.equal(`At most ${MAX_LATENCY_MS}`);
            expect(errorsOf({ jitterMs: String(MAX_JITTER_MS + 1) }).jitterMs).to.equal(`At most ${MAX_JITTER_MS}`);
            expect(errorsOf({ downKbps: String(MAX_KBPS + 1) }).downKbps).to.equal(`At most ${MAX_KBPS}`);
            expect(errorsOf({ upKbps: '99999999999' }).upKbps).to.equal(`At most ${MAX_KBPS}`);
            expect(errorsOf({ lossPct: '100.5' }).lossPct).to.equal('At most 100');

            expect(parse({
                latencyMs: String(MAX_LATENCY_MS),
                jitterMs: String(MAX_JITTER_MS),
                downKbps: String(MAX_KBPS),
                upKbps: String(MAX_KBPS),
                lossPct: '100'
            })).to.deep.equal({
                latencyMs: MAX_LATENCY_MS,
                jitterMs: MAX_JITTER_MS,
                downKbps: MAX_KBPS,
                upKbps: MAX_KBPS,
                lossPct: 100
            });
        });

        it('reports every wrong field at once, and no conditions', () => {
            const result = parseConditionsFields(fields({ latencyMs: 'x', downKbps: '-3', lossPct: '200' }));
            expect(result.ok).to.equal(false);
            if (result.ok) return;
            expect(Object.keys(result.errors).sort()).to.deep.equal(['downKbps', 'latencyMs', 'lossPct']);
        });

        it('has a label, a unit and a hint for every field', () => {
            expect(CONDITIONS_FIELDS.map((spec) => spec.field)).to.deep.equal(
                ['latencyMs', 'jitterMs', 'downKbps', 'upKbps', 'lossPct']
            );
            CONDITIONS_FIELDS.forEach((spec) => {
                expect(spec.label).not.to.equal('');
                expect(spec.unit).not.to.equal('');
                expect(spec.hint).not.to.equal('');
            });
        });
    });

    describe('devices', () => {
        const devices: ConditionsDevice[] = [
            { peer: 'p1', name: 'iPhone', lastHandshake: 1_000 },
            { peer: 'p2', name: 'iPad', lastHandshake: 5_000 },
            { peer: 'p3', name: 'Old phone' }
        ];

        it('starts on a device that has conditions on', () => {
            expect(pickDefaultDevice(devices, { p1: preset('3g').conditions })?.peer).to.equal('p1');
            expect(pickDefaultDevice(devices, { p1: null, p3: preset('edge').conditions })?.peer).to.equal('p3');
        });

        it('starts on the device that connected most recently when none has conditions', () => {
            expect(pickDefaultDevice(devices, {})?.peer).to.equal('p2');
            expect(pickDefaultDevice(devices, { p1: NO_CONDITIONS })?.peer).to.equal('p2');
        });

        it('starts on the first device when none ever connected', () => {
            const neverConnected = [{ peer: 'p7', name: 'A' }, { peer: 'p8', name: 'B' }];
            expect(pickDefaultDevice(neverConnected, {})?.peer).to.equal('p7');
        });

        it('has no default without devices', () => {
            expect(pickDefaultDevice([], {})).to.equal(undefined);
        });

        it('counts the devices that have conditions on', () => {
            expect(countActive(devices, {})).to.equal(0);
            expect(countActive(devices, { p1: preset('3g').conditions, p2: null, p3: NO_CONDITIONS })).to.equal(1);
            expect(countActive(devices, { p1: preset('3g').conditions, p2: preset('lte').conditions })).to.equal(2);
            // A device that is gone doesn't count
            expect(countActive(devices, { p9: preset('3g').conditions })).to.equal(0);
        });
    });
});
