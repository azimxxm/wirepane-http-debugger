import { expect } from '../../../test-setup';

import {
    THIS_MACHINE_KEY,
    detectDeviceType,
    getAndroidModel,
    getAppName,
    getDeviceKey,
    getEventAddress,
    getEventAppName,
    getEventDeviceKey,
    getEventHost,
    normalizeAddress
} from '../../../../src/model/devices/device-model';
import { MANUALLY_SENT_SOURCE, parseSource } from '../../../../src/model/http/sources';

import { UA, deviceExchange, failedTls, rawTunnel } from './device-test-helpers';

const request = (userAgent: string | undefined, remoteIpAddress: string | undefined) => ({
    headers: userAgent ? { 'user-agent': userAgent } : {},
    remoteIpAddress,
    url: 'http://example.com/'
});

describe('Device model', () => {

    describe('client addresses', () => {
        it('treats IPv4 clients on dual-stack sockets as the same address', () => {
            expect(normalizeAddress('::ffff:192.168.0.23')).to.equal('192.168.0.23');
            expect(normalizeAddress('192.168.0.23')).to.equal('192.168.0.23');
        });

        it('writes IPv6 addresses in their short form', () => {
            expect(normalizeAddress('fe80:0:0:0:0:0:0:1')).to.equal('fe80::1');
        });

        it('keeps addresses it cannot parse as they are', () => {
            expect(normalizeAddress('not-an-ip')).to.equal('not-an-ip');
            expect(normalizeAddress(undefined)).to.equal(undefined);
            expect(normalizeAddress('')).to.equal(undefined);
        });

        it('counts every loopback address as this machine', () => {
            ['127.0.0.1', '127.0.0.2', '::1'].forEach((address) => {
                expect(getDeviceKey(normalizeAddress(address)!)).to.equal(THIS_MACHINE_KEY, address);
            });
            expect(getEventDeviceKey(deviceExchange({ ip: '::ffff:127.0.0.1' }))).to.equal(THIS_MACHINE_KEY);
        });

        it('keys other devices by their IP', () => {
            expect(getDeviceKey('192.168.0.23')).to.equal('192.168.0.23');
            expect(getEventDeviceKey(deviceExchange({ ip: '::ffff:10.0.0.5' }))).to.equal('10.0.0.5');
            expect(getEventDeviceKey(deviceExchange({ ip: 'fd00::23' }))).to.equal('fd00::23');
        });

        it('says requests from the Send page come from this machine', () => {
            const sent = deviceExchange({ sentFromSendPage: true });
            expect(getEventAddress(sent)).to.equal(THIS_MACHINE_KEY);
            expect(getEventDeviceKey(sent)).to.equal(THIS_MACHINE_KEY);
        });

        it('reads the client address of failed TLS connections too', () => {
            expect(getEventDeviceKey(failedTls('::ffff:192.168.0.40'))).to.equal('192.168.0.40');
        });

        it('reads the client address of non-HTTP connections (raw tunnels) too', () => {
            expect(getEventDeviceKey(rawTunnel('::ffff:192.168.0.40'))).to.equal('192.168.0.40');
            expect(getEventDeviceKey(rawTunnel('127.0.0.1'))).to.equal(THIS_MACHINE_KEY);
        });

        it("doesn't guess a device for requests without an address", () => {
            expect(getEventDeviceKey(deviceExchange({ ip: undefined }))).to.equal(undefined);
        });
    });

    describe('device types', () => {
        it('recognises iPhones, iPads and other iOS devices', () => {
            expect(detectDeviceType(request(UA.iphoneSafari, '192.168.0.23'))).to.equal('iphone');
            expect(detectDeviceType(request(UA.ipadApp, '192.168.0.24'))).to.equal('ipad');
            expect(detectDeviceType(request(UA.iosAppWithModel, '192.168.0.25'))).to.equal('iphone');
            // Apps using Apple's networking don't say which device they're on
            expect(detectDeviceType(request(UA.iosApp, '192.168.0.26'))).to.equal('ios');
        });

        it('recognises Android devices, including from OkHttp apps', () => {
            expect(detectDeviceType(request(UA.androidChrome, '192.168.0.30'))).to.equal('android');
            expect(detectDeviceType(request(UA.dalvik, '192.168.0.31'))).to.equal('android');
            expect(detectDeviceType(request(UA.okhttp, '192.168.0.32'))).to.equal('android');
        });

        it("doesn't take this machine's own apps for phones", () => {
            // From loopback, Apple-networking & OkHttp user agents are Mac & JVM apps
            expect(detectDeviceType(request(UA.iosApp, '127.0.0.1'))).to.equal(undefined);
            expect(detectDeviceType(request(UA.okhttp, '127.0.0.1'))).to.equal(undefined);
        });

        it('recognises computers', () => {
            expect(detectDeviceType(request(UA.macSafari, '192.168.0.40'))).to.equal('mac');
            expect(detectDeviceType(request(UA.windowsChrome, '192.168.0.41'))).to.equal('windows');
            expect(detectDeviceType(request(UA.linuxFirefox, '192.168.0.42'))).to.equal('linux');
        });

        it("has no type for requests that don't say", () => {
            expect(detectDeviceType(request(undefined, '192.168.0.50'))).to.equal(undefined);
            expect(detectDeviceType(request(UA.curl, '192.168.0.51'))).to.equal(undefined);
        });

        it("reads an Android phone's model", () => {
            expect(getAndroidModel(UA.androidChrome)).to.equal('Pixel 8');
            expect(getAndroidModel(UA.dalvik)).to.equal('SM-S918B');
            // Chrome's reduced user agent hides the model
            expect(getAndroidModel(UA.androidReducedChrome)).to.equal(undefined);
            expect(getAndroidModel(UA.okhttp)).to.equal(undefined);
        });
    });

    describe('apps', () => {
        const appName = (userAgent: string | undefined) => getAppName({ source: parseSource(userAgent) });

        it('names browsers without their version or OS', () => {
            expect(appName(UA.iphoneSafari)).to.equal('Safari');
            expect(appName(UA.androidChrome)).to.equal('Chrome');
            expect(appName(UA.macSafari)).to.equal('Safari');
            expect(appName(UA.linuxFirefox)).to.equal('Firefox');
        });

        it('names apps and tools from their user agent', () => {
            expect(appName(UA.iosApp)).to.equal('Bookshelf');
            expect(appName('My%20App/1.0 CFNetwork/1498.700.2 Darwin/24.0.0')).to.equal('My App');
            expect(appName(UA.curl)).to.equal('curl');
            expect(appName(UA.okhttp)).to.equal('OkHttp');
            expect(appName(UA.dalvik)).to.equal('Dalvik');
        });

        it('names requests without a user agent like the Source column does', () => {
            expect(appName(undefined)).to.equal('Unknown client');
            expect(getAppName({ source: MANUALLY_SENT_SOURCE })).to.equal('Wirepane (Send)');
        });

        it("reads an event's app from the client's side", () => {
            expect(getEventAppName(deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }))).to.equal('Safari');
            expect(getEventAppName(failedTls('192.168.0.23'))).to.equal(undefined);
        });
    });

    describe('hosts', () => {
        it('reads the hostname of requests and connections', () => {
            expect(getEventHost(deviceExchange({ host: 'API.Example.com' }))).to.equal('api.example.com');
            expect(getEventHost(failedTls('192.168.0.23', 'Cert.Example.com'))).to.equal('cert.example.com');
            expect(getEventHost(rawTunnel('192.168.0.23', 'MQTT.Example.com'))).to.equal('mqtt.example.com');
        });
    });
});
