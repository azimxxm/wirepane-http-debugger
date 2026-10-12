import { observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { HttpExchange } from '../../../../src/types';
import { parseSource } from '../../../../src/model/http/sources';
import { NetworkInterfaces } from '../../../../src/services/server-api-types';
import {
    ConnectedPhoneTracker,
    describeConnectedApps,
    getAppleDeviceName,
    getLanAddresses,
    isIOSUserAgent,
    isLoopbackAddress,
    matchPhoneRequest
} from '../../../../src/model/interception/phone-setup';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_APP = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IOS_APP = 'Instagram/1.0 CFNetwork/1498.700.2 Darwin/23.6.0';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const OKHTTP = 'okhttp/4.12.0';

const iface = (address: string, overrides: { family?: 'IPv4' | 'IPv6', internal?: boolean } = {}) => ({
    address,
    netmask: '255.255.255.0',
    family: overrides.family ?? 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: overrides.internal ?? false,
    cidr: null
}) as any;

const request = (
    userAgent: string | undefined,
    remoteIpAddress: string | undefined,
    url = 'http://example.com/',
    tags: string[] = []
) => ({
    headers: userAgent ? { 'user-agent': userAgent } : {},
    remoteIpAddress,
    url,
    tags
});

describe('Phone setup', () => {

    describe("this machine's LAN addresses", () => {
        it('picks the Wi-Fi/Ethernet LAN address first', () => {
            const interfaces: NetworkInterfaces = {
                lo0: [iface('127.0.0.1', { internal: true })],
                utun3: [iface('10.8.0.2')],
                en1: [iface('fe80::1', { family: 'IPv6' }), iface('192.168.0.156')],
                bridge100: [iface('192.168.64.1')]
            };

            expect(getLanAddresses(interfaces)).to.deep.equal([
                { address: '192.168.0.156', interfaceName: 'en1' },
                // Private, but on virtual interfaces (VPN, VM bridge), so after the real one
                { address: '10.8.0.2', interfaceName: 'utun3' },
                { address: '192.168.64.1', interfaceName: 'bridge100' }
            ]);
        });

        it('keeps the system order for equally good addresses', () => {
            const interfaces: NetworkInterfaces = {
                en0: [iface('10.0.0.5')],
                en7: [iface('192.168.1.20')]
            };

            expect(getLanAddresses(interfaces).map((a) => a.address))
                .to.deep.equal(['10.0.0.5', '192.168.1.20']);
        });

        it('leaves out Docker, link-local and loopback addresses', () => {
            const interfaces: NetworkInterfaces = {
                docker0: [iface('172.17.0.1')],
                'br-1a2b3c': [iface('172.18.0.1')],
                veth12ab: [iface('172.17.0.3')],
                en0: [iface('169.254.10.20')], // No DHCP: not a working network
                lo: [iface('127.0.0.1', { internal: true })]
            };

            expect(getLanAddresses(interfaces)).to.deep.equal([]);
        });

        it('puts public addresses after LAN ones', () => {
            const interfaces: NetworkInterfaces = {
                eth0: [iface('203.0.113.7')],
                wlan0: [iface('192.168.0.40')]
            };

            expect(getLanAddresses(interfaces).map((a) => a.address))
                .to.deep.equal(['192.168.0.40', '203.0.113.7']);
        });
    });

    describe('recognising iOS traffic', () => {
        it('spots iPhone, iPad and iOS app user agents', () => {
            expect(isIOSUserAgent(IPHONE_SAFARI)).to.equal(true);
            expect(isIOSUserAgent(IPAD_APP)).to.equal(true);
            expect(isIOSUserAgent(IOS_APP)).to.equal(true);
        });

        it("doesn't count desktop or Android user agents", () => {
            expect(isIOSUserAgent(MAC_SAFARI)).to.equal(false);
            expect(isIOSUserAgent(ANDROID_CHROME)).to.equal(false);
            expect(isIOSUserAgent('curl/8.7.1')).to.equal(false);
            expect(isIOSUserAgent(undefined)).to.equal(false);
        });

        it('names the device when the user agent says', () => {
            expect(getAppleDeviceName(IPHONE_SAFARI)).to.equal('iPhone');
            expect(getAppleDeviceName(IPAD_APP)).to.equal('iPad');
            expect(getAppleDeviceName(IOS_APP)).to.equal('iPhone or iPad');
        });

        it('matches iOS requests from other devices, with their IPv4 address', () => {
            expect(matchPhoneRequest(request(IPHONE_SAFARI, '::ffff:192.168.0.23'), 'ios')).to.deep.equal({
                deviceName: 'iPhone',
                address: '192.168.0.23',
                https: false
            });
        });

        it("ignores iOS-looking requests from this machine, e.g. Mac apps' CFNetwork traffic", () => {
            expect(matchPhoneRequest(request(IOS_APP, '127.0.0.1'), 'ios')).to.equal(undefined);
            expect(matchPhoneRequest(request(IOS_APP, '::1'), 'ios')).to.equal(undefined);
            expect(matchPhoneRequest(request(IPHONE_SAFARI, '::ffff:127.0.0.1'), 'ios')).to.equal(undefined);
            expect(matchPhoneRequest(request(IPHONE_SAFARI, undefined), 'ios')).to.equal(undefined);
        });

        it('notes HTTPS requests', () => {
            expect(matchPhoneRequest(
                request(IOS_APP, '192.168.0.23', 'https://api.example.com/v1'),
                'ios'
            )?.https).to.equal(true);
        });

        it('knows loopback addresses', () => {
            expect(isLoopbackAddress('127.0.0.1')).to.equal(true);
            expect(isLoopbackAddress('::ffff:127.0.0.1')).to.equal(true);
            expect(isLoopbackAddress('192.168.0.23')).to.equal(false);
            expect(isLoopbackAddress('not an ip')).to.equal(false);
        });
    });

    describe('recognising Android traffic', () => {
        it('matches Android requests from other devices', () => {
            expect(matchPhoneRequest(request(ANDROID_CHROME, '192.168.0.40'), 'android')).to.deep.equal({
                deviceName: 'Android device',
                address: '192.168.0.40',
                https: false
            });
        });

        it('matches Android requests tunnelled through ADB, without an address', () => {
            expect(matchPhoneRequest(request(ANDROID_CHROME, '127.0.0.1'), 'android')).to.deep.equal({
                deviceName: 'Android device',
                address: undefined,
                https: false
            });
        });

        it("only counts OkHttp from other devices, since JVM apps here use it too", () => {
            expect(matchPhoneRequest(request(OKHTTP, '192.168.0.40'), 'android')?.deviceName)
                .to.equal('Android device');
            expect(matchPhoneRequest(request(OKHTTP, '127.0.0.1'), 'android')).to.equal(undefined);
        });

        it("doesn't match iOS traffic, or requests without a user agent", () => {
            expect(matchPhoneRequest(request(IPHONE_SAFARI, '192.168.0.23'), 'android')).to.equal(undefined);
            expect(matchPhoneRequest(request(undefined, '192.168.0.23'), 'android')).to.equal(undefined);
        });
    });

    describe('tracking the connected phone', () => {
        const exchange = (
            userAgent: string,
            remoteIpAddress: string,
            options: { url?: string, startTime?: number, tags?: string[] } = {}
        ) => ({
            request: {
                ...request(userAgent, remoteIpAddress, options.url, options.tags),
                timingEvents: { startTime: options.startTime ?? Date.now() },
                source: parseSource(userAgent)
            }
        }) as unknown as HttpExchange;

        let exchanges: HttpExchange[];
        let tracker: ConnectedPhoneTracker;

        beforeEach(() => {
            exchanges = observable.array<HttpExchange>([], { deep: false });
            tracker = new ConnectedPhoneTracker(() => exchanges, 'ios', 1000);
        });

        afterEach(() => tracker.stop());

        it('waits until a phone request arrives', () => {
            tracker.start();
            expect(tracker.phone).to.equal(undefined);

            runInAction(() => exchanges.push(exchange('curl/8.7.1', '127.0.0.1')));
            expect(tracker.phone).to.equal(undefined);

            runInAction(() => exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23')));
            expect(tracker.phone).to.deep.equal({
                deviceName: 'iPhone',
                address: '192.168.0.23',
                apps: ['Safari'],
                otherClients: [],
                viaVpn: false,
                sawHttps: false
            });
        });

        it('counts traffic captured before the page opened', () => {
            exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23'));
            tracker.start();
            expect(tracker.phone?.address).to.equal('192.168.0.23');
        });

        it('ignores traffic from before the UI started, like imported HAR files', () => {
            exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23', { startTime: 500 }));
            tracker.start();
            expect(tracker.phone).to.equal(undefined);
        });

        it('remembers that HTTPS worked for that device', () => {
            tracker.start();
            runInAction(() => exchanges.push(
                exchange(IOS_APP, '192.168.0.23', { url: 'https://api.example.com/' }),
                exchange(IPHONE_SAFARI, '192.168.0.23', { url: 'http://example.com/' })
            ));

            expect(tracker.phone?.sawHttps).to.equal(true);
            expect(tracker.phone?.apps).to.deep.equal(['Instagram', 'Safari']);
        });

        it("lists the phone's apps, not the SDK that sent the latest request", () => {
            tracker.start();
            runInAction(() => exchanges.push(
                exchange(IPHONE_SAFARI, '192.168.0.23'),
                exchange(IOS_APP, '192.168.0.23'),
                exchange(IOS_APP, '192.168.0.23'),
                // Neither of these looks like a phone's user agent to matchPhoneRequest, but they're its traffic
                exchange('uz.kashapp.road24/3.6.0 GMS-SDK/9.4.0.0 iPhone/26.6.1 hw/iPhone14_3 (gzip)', '192.168.0.23'),
                exchange('FBiOSSDK.18.1.0', '192.168.0.23'),
                exchange('server-bag [iPhone OS,26.6.1,23G83,iPhone14,3]', '192.168.0.23'),
                // The latest request, from an SDK
                exchange('io.appmetrica.analytics/5.8.2.0 (Apple iPhone14,3; iOS 26.6.1)', '192.168.0.23'),
                // Another machine, and this one
                exchange('Spotify/1.0 CFNetwork/1498.700.2 Darwin/23.6.0', '192.168.0.99'),
                exchange('curl/8.7.1', '127.0.0.1')
            ));

            // The latest phone request was the other device's, so the first phone's next request brings it back
            expect(tracker.phone?.address).to.equal('192.168.0.99');
            runInAction(() => exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23')));
            expect(tracker.phone).to.deep.include({
                address: '192.168.0.23',
                apps: ['Instagram', 'Safari', 'uz.kashapp.road24'],
                otherClients: ['AppMetrica SDK', 'Facebook SDK', 'iOS system']
            });
        });

        it("keeps calling a phone an iPhone after an app request that doesn't say which it is", () => {
            tracker.start();
            runInAction(() => exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23')));
            runInAction(() => exchanges.push(exchange(IOS_APP, '192.168.0.23')));

            expect(tracker.phone?.deviceName).to.equal('iPhone');
        });

        it('calls a phone by the generic name until a request says what it is', () => {
            tracker.start();
            runInAction(() => exchanges.push(exchange(IOS_APP, '192.168.0.23')));
            expect(tracker.phone?.deviceName).to.equal('iPhone or iPad');

            runInAction(() => exchanges.push(exchange(IPAD_APP, '192.168.0.23')));
            expect(tracker.phone?.deviceName).to.equal('iPad');
        });

        it('knows a phone whose traffic comes through the VPN tunnel', () => {
            const vpnTags = ['wirepane-vpn', 'wirepane-vpn-peer:p1', 'wirepane-vpn-endpoint:192.168.0.199'];
            tracker.start();
            runInAction(() => exchanges.push(exchange(IPHONE_SAFARI, '127.0.0.1', { tags: vpnTags })));

            expect(tracker.phone).to.deep.include({
                deviceName: 'iPhone',
                address: '192.168.0.199',
                viaVpn: true,
                apps: ['Safari']
            });
        });

        it('describes the apps in plain words', () => {
            expect(describeConnectedApps({ apps: [], otherClients: [] })).to.equal('No apps yet');
            expect(describeConnectedApps({ apps: [], otherClients: ['iOS system'] })).to.equal('Only iOS system so far');
            expect(describeConnectedApps({ apps: ['Safari'], otherClients: [] })).to.equal('Safari');
            expect(describeConnectedApps({ apps: ['Safari', 'KursMate', 'road24'], otherClients: [] }))
                .to.equal('Safari, KursMate, road24');
            expect(describeConnectedApps({ apps: ['Jett', 'KursMate', 'road24', 'ATTO', 'Safari'], otherClients: ['iOS system'] }))
                .to.equal('5 apps: Jett, KursMate, road24 and 2 more');
        });

        it('shows the latest device', () => {
            tracker.start();
            runInAction(() => exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23')));
            runInAction(() => exchanges.push(exchange(IPAD_APP, '192.168.0.31')));

            expect(tracker.phone?.deviceName).to.equal('iPad');
            expect(tracker.phone?.address).to.equal('192.168.0.31');
        });

        it('starts over when the traffic is cleared', () => {
            tracker.start();
            runInAction(() => exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23')));
            expect(tracker.phone).to.not.equal(undefined);

            runInAction(() => exchanges.splice(0, exchanges.length));
            expect(tracker.phone).to.equal(undefined);
        });

        it('stops watching once stopped', () => {
            tracker.start();
            tracker.stop();

            runInAction(() => exchanges.push(exchange(IPHONE_SAFARI, '192.168.0.23')));
            expect(tracker.phone).to.equal(undefined);
        });
    });
});
