import * as http from 'http';
import { expect } from 'chai';
import { generateCACertificate } from 'mockttp';

import {
    buildIkev2Profile,
    createIkev2ProfileAnswer,
    IKEV2_SERVER_IDENTITY,
    Ikev2ProfileOptions,
    parseIkev2PeerAdded,
    phoneIdentity,
    PROFILE_MIME_TYPE,
    ProfileLink,
    serveProfileOnce
} from '../../src/interceptors/wireguard-vpn-ikev2';

// The plist package comes with usbmux-client (a server dependency). It's only used here, to
// read our own XML back with a real parser instead of trusting our writer.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const plist: { parse(xml: string): any } = require('plist');

const SECRET = 'q2Vn0bS2c7m1tY5oW8fJ3uQ4xZ9aL6eR1hK0pD7sG2c=';

function get(url: string, method = 'GET'): Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }> {
    return new Promise((resolve, reject) => {
        // A fresh connection each time, so a closed link shows as refused, not as a reused socket reset
        const req = http.request(url, { method, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('IKEv2 profile for iPhones', function () {
    this.timeout(20000);

    let caPem: string;
    let options: Ikev2ProfileOptions;

    before(async () => {
        const ca = await generateCACertificate({ commonName: 'Wirepane CA (test)' });
        caPem = ca.cert;
        options = {
            peer: 'p3',
            deviceName: 'iPhone',
            serverAddress: '192.168.0.199',
            sharedSecret: SECRET,
            caCertificatePem: caPem
        };
    });

    it('builds a plist that installs the CA and an IKEv2 VPN', () => {
        const profile = plist.parse(buildIkev2Profile(options));

        expect(profile.PayloadType).to.equal('Configuration');
        expect(profile.PayloadVersion).to.equal(1);
        expect(profile.PayloadIdentifier).to.equal('com.wirepane.vpn.p3');
        expect(profile.PayloadDisplayName).to.equal('Wirepane VPN (iPhone)');
        expect(profile.PayloadContent).to.have.length(2);

        const [ca, vpn] = profile.PayloadContent;
        expect(ca.PayloadType).to.equal('com.apple.security.root');
        const der = Buffer.from(caPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
        expect(Buffer.from(ca.PayloadContent).equals(der)).to.equal(true);

        expect(vpn.PayloadType).to.equal('com.apple.vpn.managed');
        expect(vpn.VPNType).to.equal('IKEv2');
        expect(vpn.UserDefinedName).to.equal('Wirepane');
        expect(vpn.IKEv2).to.deep.include({
            RemoteAddress: '192.168.0.199',
            RemoteIdentifier: IKEV2_SERVER_IDENTITY,
            LocalIdentifier: 'p3.wirepane',
            AuthenticationMethod: 'SharedSecret',
            SharedSecret: SECRET,
            ExtendedAuthEnabled: 0,
            EnablePFS: 0,
            DisableMOBIKE: 1,
            DisableRedirect: 1,
            DeadPeerDetectionRate: 'Medium'
        });
        // The one proposal the sidecar's responder accepts
        const proposal = {
            EncryptionAlgorithm: 'AES-256-GCM',
            IntegrityAlgorithm: 'SHA2-256',
            DiffieHellmanGroup: 19,
            LifeTimeInMinutes: 1440
        };
        expect(vpn.IKEv2.IKESecurityAssociationParameters).to.deep.equal(proposal);
        expect(vpn.IKEv2.ChildSecurityAssociationParameters).to.deep.equal(proposal);

        // Every payload has its own UUID
        const uuids = [profile, ca, vpn].map((payload) => payload.PayloadUUID);
        expect(new Set(uuids).size).to.equal(3);
        uuids.forEach((uuid) => expect(uuid).to.match(/^[0-9A-F-]{36}$/));
    });

    it('keeps the identifier but not the UUIDs for the same device', () => {
        const first = plist.parse(buildIkev2Profile(options));
        const second = plist.parse(buildIkev2Profile(options));
        expect(second.PayloadIdentifier).to.equal(first.PayloadIdentifier);
        expect(second.PayloadUUID).not.to.equal(first.PayloadUUID);
    });

    it('escapes device names and drops control characters', () => {
        const profile = plist.parse(buildIkev2Profile({
            ...options,
            deviceName: 'Tom\'s <iPhone> & "co"\u0007</string>'
        }));
        expect(profile.PayloadDisplayName).to.equal('Wirepane VPN (Tom\'s <iPhone> & "co" </string>)');
        expect(profile.PayloadContent).to.have.length(2);
    });

    it('refuses bad input instead of writing a broken profile', () => {
        expect(() => buildIkev2Profile({ ...options, peer: 'p3</string>' })).to.throw(/peer id/);
        expect(() => buildIkev2Profile({ ...options, serverAddress: '192.168.0.300' })).to.throw(/server address/);
        expect(() => buildIkev2Profile({ ...options, serverAddress: 'example.com' })).to.throw(/server address/);
        expect(() => buildIkev2Profile({ ...options, sharedSecret: 'short' })).to.throw(/shared secret/);
        expect(() => buildIkev2Profile({ ...options, caCertificatePem: 'not a certificate' })).to.throw(/PEM/);
    });

    it('names phones like the sidecar does', () => {
        expect(phoneIdentity('p12')).to.equal('p12.wirepane');
    });

    describe('from the sidecar\'s peer to the UI\'s answer', () => {
        const added = {
            event: 'peer-added',
            peer: 'p7',
            name: 'iPhone',
            kind: 'ikev2',
            tunnelIp: '10.73.0.8',
            ikev2: { localId: 'p7.wirepane', remoteId: 'vpn.wirepane', psk: SECRET }
        };

        it('reads the sidecar\'s ikev2 peer only when the identities match', () => {
            expect(parseIkev2PeerAdded(added)).to.deep.equal({
                peer: 'p7', name: 'iPhone', tunnelIp: '10.73.0.8',
                ikev2: { localId: 'p7.wirepane', remoteId: 'vpn.wirepane', psk: SECRET }
            });
            expect(parseIkev2PeerAdded({ ...added, ikev2: { ...added.ikev2, localId: 'p8.wirepane' } })).to.equal(undefined);
            expect(parseIkev2PeerAdded({ ...added, ikev2: { ...added.ikev2, remoteId: 'other' } })).to.equal(undefined);
            expect(parseIkev2PeerAdded({ ...added, peer: '../p7' })).to.equal(undefined);
            expect(parseIkev2PeerAdded({ ...added, ikev2: undefined })).to.equal(undefined);
            expect(parseIkev2PeerAdded('peer-added')).to.equal(undefined);
        });

        it('answers with the profile and a link that stopping can close', async () => {
            const links = new Set<ProfileLink>();
            const answer = await createIkev2ProfileAnswer(parseIkev2PeerAdded(added)!, {
                caCertificatePem: caPem,
                serverAddress: '127.0.0.1',
                links
            });
            expect(answer.peer).to.equal('p7');
            expect(plist.parse(answer.profile).PayloadContent[1].IKEv2.LocalIdentifier).to.equal('p7.wirepane');
            expect(answer.link).to.match(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.mobileconfig$/);
            expect(links.size).to.equal(1);

            const download = await get(answer.link!);
            expect(download.body).to.equal(answer.profile);
            await Promise.all([...links].map((link) => link.closed));
            expect(links.size).to.equal(0);
        });
    });

    describe('one-time download link', () => {

        it('serves the profile once, then closes', async () => {
            const link = await serveProfileOnce('<plist>test</plist>', '127.0.0.1');
            expect(link.url).to.match(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.mobileconfig$/);

            const wrongPath = await get(link.url.replace(/[0-9a-f]{32}/, '0'.repeat(32)));
            expect(wrongPath.status).to.equal(404);

            // HEAD doesn't use the link up
            const head = await get(link.url, 'HEAD');
            expect(head.status).to.equal(200);
            expect(head.headers['content-type']).to.equal(PROFILE_MIME_TYPE);

            const download = await get(link.url);
            expect(download.status).to.equal(200);
            expect(download.headers['content-type']).to.equal(PROFILE_MIME_TYPE);
            expect(download.headers['cache-control']).to.equal('no-store');
            expect(download.body).to.equal('<plist>test</plist>');

            expect(await link.closed).to.equal('downloaded');
            const error = await get(link.url).then(() => undefined, (e: any) => e);
            expect(error?.code).to.equal('ECONNREFUSED');
        });

        it('expires after its time limit', async () => {
            const link = await serveProfileOnce('<plist/>', '127.0.0.1', 50);
            expect(await link.closed).to.equal('expired');
        });

        it('can be closed early', async () => {
            const link = await serveProfileOnce('<plist/>', '127.0.0.1');
            link.close();
            expect(await link.closed).to.equal('closed');
            link.close(); // twice is harmless
        });

        it('only listens on an IPv4 address', async () => {
            const error = await serveProfileOnce('<plist/>', 'localhost').then(() => undefined, (e: any) => e);
            expect(error?.message).to.match(/IPv4/);
        });
    });
});
