import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import {
    isIkev2Unsupported,
    parseIkev2ProfileAnswer,
    VpnIkev2Setup
} from '../../../../src/components/intercept/phone/vpn-ikev2-setup';
import { VpnIkev2Option } from '../../../../src/components/intercept/phone/vpn-ikev2-option';

const LINK = 'http://192.168.0.10:61000/0123456789abcdef0123456789abcdef.mobileconfig';
const ANSWER = { peer: 'p4', name: 'iPhone', profile: '<?xml version="1.0"?><plist></plist>', link: LINK };

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe('iPhone page, IKEv2 option', () => {

    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        ReactDOM.unmountComponentAtNode(container);
        container.remove();
    });

    const render = (element: React.ReactElement) => act(() => {
        ReactDOM.render(<ThemeProvider theme={lightTheme}>{ element }</ThemeProvider>, container);
    });

    const button = (label: RegExp) => Array.from(container.querySelectorAll('button'))
        .find((b) => label.test(b.textContent ?? ''));

    it('reads only well-formed server answers', () => {
        expect(parseIkev2ProfileAnswer(ANSWER)).to.deep.equal(ANSWER);
        expect(parseIkev2ProfileAnswer({ ...ANSWER, profile: 'no plist here' })).to.equal(undefined);
        expect(parseIkev2ProfileAnswer({ ...ANSWER, peer: 4 })).to.equal(undefined);
        expect(parseIkev2ProfileAnswer(null)).to.equal(undefined);
        // A link of any other shape is dropped, not shown as a QR code
        expect(parseIkev2ProfileAnswer({ ...ANSWER, link: 'javascript:alert(1)' })?.link).to.equal(undefined);
        expect(parseIkev2ProfileAnswer({ ...ANSWER, link: 'http://evil.example/x.mobileconfig' })?.link).to.equal(undefined);
    });

    it('recognises a server without IKEv2', () => {
        expect(isIkev2Unsupported(new Error('Unknown wireguard-vpn action: ikev2-profile'))).to.equal(true);
        expect(isIkev2Unsupported(new Error('add-peer failed: IKEv2 is not running (start with --ikev2)'))).to.equal(true);
        expect(isIkev2Unsupported(new Error('The VPN helper (wirepane-tunnel) is not built.'))).to.equal(false);
        expect(isIkev2Unsupported(undefined)).to.equal(false);
    });

    it('opens its steps from the card', async () => {
        await render(<VpnIkev2Option />);
        expect(container.textContent).to.include('Without an app (IKEv2, beta)');
        const toggle = button(/Show the steps/)!;
        expect(toggle.getAttribute('aria-expanded')).to.equal('false');
        // The steps need the proxy store, so only the closed card is rendered here
        expect(container.textContent).not.to.include('Install the profile');
    });

    it('creates the profile only when asked, then offers AirDrop and the one-time link', async () => {
        const requests: Array<[number, string]> = [];
        const requestProfile = async (port: number, name: string) => {
            requests.push([port, name]);
            return ANSWER;
        };
        await render(<VpnIkev2Setup proxyStore={{ httpProxyPort: 8000 } as any} requestProfile={requestProfile} />);
        expect(requests).to.deep.equal([]);
        expect(container.textContent).to.include('Install the profile');

        await act(async () => { button(/Create the profile/)!.click(); });
        await flush();
        expect(requests).to.deep.equal([[8000, 'iPhone']]);
        expect(button(/Save profile/)).to.not.equal(undefined);
        expect(container.textContent).to.include(LINK);
        expect(container.querySelector('svg[role="img"]')).to.not.equal(null);
    });

    it('says when this build has no IKEv2 yet', async () => {
        const requestProfile = async () => { throw new Error('Unknown wireguard-vpn action: ikev2-profile'); };
        await render(<VpnIkev2Setup proxyStore={{ httpProxyPort: 8000 } as any} requestProfile={requestProfile} />);
        await act(async () => { button(/Create the profile/)!.click(); });
        await flush();
        expect(container.textContent).to.include("can't run the IKEv2 VPN yet");
        expect((button(/Create the profile/) as HTMLButtonElement).disabled).to.equal(true);
    });

    it('shows other failures as they are', async () => {
        const requestProfile = async () => { throw new Error('the helper stopped'); };
        await render(<VpnIkev2Setup proxyStore={{ httpProxyPort: 8000 } as any} requestProfile={requestProfile} />);
        await act(async () => { button(/Create the profile/)!.click(); });
        await flush();
        expect(container.textContent).to.include("Couldn't create the profile: the helper stopped");
    });
});
