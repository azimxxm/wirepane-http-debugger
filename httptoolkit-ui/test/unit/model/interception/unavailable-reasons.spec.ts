import { expect } from '../../../test-setup';

import { Interceptor } from '../../../../src/model/interception/interceptors';
import {
    getUnavailableReason,
    THIS_MACHINE
} from '../../../../src/model/interception/unavailable-reasons';

const interceptor = (id: string, extra: Partial<Interceptor> = {}) => ({
    id,
    name: id,
    tags: [],
    isSupported: true,
    isActivable: false,
    ...extra
}) as unknown as Interceptor;

describe('Unavailable intercept option reasons', () => {

    it('should say a supported browser is not installed', () => {
        expect(getUnavailableReason(interceptor('fresh-firefox', { tags: ['browsers'] })).text)
            .to.equal(`Not installed on ${THIS_MACHINE}`);
    });

    it("shouldn't blame installation for browsers Wirepane can't launch", () => {
        const arc = interceptor('existing-arc', { tags: ['browsers'], isSupported: false });
        expect(getUnavailableReason(arc).text).to.equal(`Not available on ${THIS_MACHINE}`);
    });

    it('should give the next step for Docker, ADB & Frida', () => {
        expect(getUnavailableReason(interceptor('docker-attach')).text).to.match(/^Start Docker/);

        const adb = getUnavailableReason(interceptor('android-adb', {
            notAvailableHelpUrl: 'https://example.com/adb-help'
        }));
        expect(adb.text).to.equal('Needs adb (Android platform-tools)');
        expect(adb.helpUrl).to.equal('https://example.com/adb-help');

        expect(getUnavailableReason(interceptor('android-frida')).text)
            .to.equal('Needs a rooted/jailbroken device with frida-server');
        expect(getUnavailableReason(interceptor('ios-frida')).text)
            .to.equal('Needs a rooted/jailbroken device with frida-server');
    });

    it('should fall back to a generic reason', () => {
        expect(getUnavailableReason(interceptor('virtualbox-machine')).text)
            .to.equal(`Not available on ${THIS_MACHINE}`);
    });

});
