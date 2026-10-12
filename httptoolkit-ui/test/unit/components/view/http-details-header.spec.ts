import { expect } from '../../../test-setup';

import { getHeaderDensity } from '../../../../src/components/view/http/http-details-header';

describe('HTTP details header', () => {

    it('keeps every label & shortcut, and a Breakpoint button, in a wide pane', () => {
        expect(getHeaderDensity(undefined)).to.equal('full');
        expect(getHeaderDensity(900)).to.equal('full');
        expect(getHeaderDensity(760)).to.equal('full');
    });

    it('moves Breakpoint into More first, keeping the shortcut hints', () => {
        expect(getHeaderDensity(759)).to.equal('compact');
        expect(getHeaderDensity(668)).to.equal('compact'); // A 1440px window, Devices hidden
        expect(getHeaderDensity(640)).to.equal('compact');
    });

    it('keeps the Mock response & Resend labels down to 480px', () => {
        expect(getHeaderDensity(631)).to.equal('labels'); // A 1366px window, Devices hidden
        expect(getHeaderDensity(543)).to.equal('labels'); // A 1366px window, Devices shown
        expect(getHeaderDensity(480)).to.equal('labels');
        expect(getHeaderDensity(479)).to.equal('icons');
    });

});
