import * as React from 'react';

import { styled } from '../../styles';
import { PhosphorIcon } from '../../icons';
import { copyToClipboard } from '../../util/ui';
import { logError } from '../../errors';

import { UnstyledButton } from '../common/inputs';

const COPIED_FEEDBACK_MS = 1500;

const Line = styled.p`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};
`;

const Strong = styled.span`
    color: ${p => p.theme.mainColor};
    font-weight: 600;
`;

const ProxyAddress = styled.span`
    font-family: ${p => p.theme.monoFontFamily};
    color: ${p => p.theme.mainColor};
`;

const SmallButton = styled(UnstyledButton)`
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    border: 1px solid ${p => p.theme.inputBorder};
    background-color: ${p => p.theme.mainBackground};

    display: inline-flex;
    align-items: center;
    gap: 4px;

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 500;
    color: ${p => p.theme.mainColor};

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }
`;

const Separator = styled.span`
    margin: 0 4px;
`;

/**
 * The manual route for anything without a dedicated option: point it at the proxy
 * and trust the CA. "Set up" opens the full manual instructions.
 */
export const ManualProxyLine = (props: {
    proxyPort: number,
    setupOpen: boolean,
    onToggleSetup: () => void
}) => {
    const [copied, setCopied] = React.useState(false);
    React.useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const proxyUrl = `http://localhost:${props.proxyPort}`;

    return <Line>
        <Strong>Any other app:</Strong>
        <span>proxy <ProxyAddress>localhost:{ props.proxyPort }</ProxyAddress></span>
        <SmallButton
            onClick={() => copyToClipboard(proxyUrl)
                .then(() => setCopied(true))
                .catch((e) => logError(e))
            }
            title={`Copy ${proxyUrl}`}
        >
            { copied && <PhosphorIcon icon='Check' size={12} weight='bold' aria-hidden={true} /> }
            { copied ? 'Copied' : 'Copy' }
        </SmallButton>
        <Separator aria-hidden={true}>·</Separator>
        <span>trust the Wirepane CA certificate</span>
        <SmallButton
            onClick={props.onToggleSetup}
            aria-expanded={props.setupOpen}
            title='Show the manual setup steps. In your certificate settings, the CA is called "Wirepane CA".'
        >
            Set up
        </SmallButton>
    </Line>;
};
