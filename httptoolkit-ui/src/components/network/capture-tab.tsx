import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';

import { styled, css, keyframes } from '../../styles';
import { copyToClipboard } from '../../util/ui';
import { VpnNetworkStore } from '../../model/interception/vpn-network';

import { ActionButton } from '../common/action-button';
import {
    CaptureAction,
    CaptureView,
    describeCapture,
    describeCaptureError
} from './capture-tab-model';

const Root = styled.section`
    box-sizing: border-box;
    padding: 20px;
    min-width: 0;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;
`;

const Header = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 12px 14px;
`;

const recordingPulse = keyframes`
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
`;

const pulse = css`
    animation: ${recordingPulse} 1.6s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
        animation: none;
    }
`;

const Dot = styled.span<{ recording: boolean }>`
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    /* 12px + 2 * 6px is as wide as the 24px check icon, so the title doesn't move between states */
    margin: 4px 6px 0;
    border-radius: 50%;
    background-color: ${p => p.recording ? p.theme.popColor : p.theme.containerWatermark};

    ${p => p.recording && pulse}
`;

const SavedIcon = styled.span`
    flex-shrink: 0;
    display: flex;
    color: ${p => p.theme.popColor};
`;

const Text = styled.div`
    flex: 1 1 260px;
    min-width: 0;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};

    > * + * {
        margin-top: 4px;
    }
`;

const Title = styled.h2`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
    color: ${p => p.theme.mainColor};
`;

const Counters = styled.dl`
    margin: 20px 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 40px;
`;

const Counter = styled.div`
    min-width: 0;

    > dt {
        font-size: ${p => p.theme.textInputFontSize};
        color: ${p => p.theme.mainLowlightColor};
    }

    > dd {
        margin: 2px 0 0;
        font-size: 24px;
        font-weight: 600;
        line-height: 1.2;
        color: ${p => p.theme.mainColor};

        /* The numbers change every second, so equal-width digits keep them from jittering */
        font-variant-numeric: tabular-nums;
    }
`;

const Location = styled.div`
    margin-top: 20px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
`;

const LocationLabel = styled.span`
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const PathText = styled.code`
    flex: 1 1 260px;
    min-width: 0;
    box-sizing: border-box;
    padding: 6px 8px;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: 12px;
    line-height: 1.4;
    color: ${p => p.theme.mainColor};
    overflow-wrap: anywhere;

    background-color: ${p => p.theme.containerBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
`;

const Problem = styled.p`
    margin: 16px 0 0;
    padding: 8px 10px;
    display: flex;
    align-items: flex-start;
    gap: 8px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.warning};
    background-color: ${p => p.theme.warningBackground};
    border-radius: 6px;

    > svg {
        flex-shrink: 0;
        margin-top: 1px;
    }
`;

const Notes = styled.div`
    margin-top: 20px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.5;
    color: ${p => p.theme.mainLowlightColor};

    > p + p {
        margin-top: 4px;
    }
`;

const COPY_FEEDBACK_MS = 2000;

type CopyState = 'copied' | 'failed' | undefined;

const CopyPathButton = (props: { path: string }) => {
    const [state, setState] = React.useState<CopyState>();
    const resetTimer = React.useRef<number | undefined>(undefined);

    // The message goes back to "Copy path" on its own; a timer left over from a closed tab must not fire
    React.useEffect(() => () => window.clearTimeout(resetTimer.current), []);

    const copy = async () => {
        try {
            await copyToClipboard(props.path);
            setState('copied');
        } catch {
            setState('failed');
        }
        window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setState(undefined), COPY_FEEDBACK_MS);
    };

    return <ActionButton
        variant='secondary'
        icon={state === 'copied' ? 'Check' : undefined}
        title='Copy the full path of the file'
        onClick={copy}
    >
        { state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy path' }
    </ActionButton>;
};

// Pages come and go while a start or stop request is in flight, and a late answer must not touch
// a component that is gone.
const useMountedRef = () => {
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    return mounted;
};

const phaseTitle = (view: CaptureView) =>
    view.phase === 'running' ? 'Capturing packets'
    : view.phase === 'saved' ? 'Capture saved'
    : "Save the phone's packets to a file";

const PhaseText = (props: { view: CaptureView }) => {
    const { view } = props;

    if (view.phase === 'running') return <p>
        Every packet to and from the phone is being written to the file. Stop when you have the
        traffic you need.
    </p>;

    if (view.phase === 'saved') return <p>
        { view.isEmpty
            ? 'No packets were captured. Check that the phone is connected to the VPN and sending traffic, then try again.'
            : 'Open the file in Wireshark. Each phone is its own interface, so you can look at one phone at a time.'
        }
    </p>;

    return <p>
        Records every IP packet that goes through the VPN into a .pcapng file for Wireshark. Each
        phone is its own interface in the file.
    </p>;
};

/**
 * Start and stop a packet capture of the VPN tunnel. While it runs the packet and byte counts
 * count up; when it ends the page shows where the file is, with a button to copy its path.
 */
export const CaptureTab = observer((props: { store: VpnNetworkStore }) => {
    const { store } = props;
    const view = describeCapture(store.capture);

    const [busy, setBusy] = React.useState<CaptureAction | undefined>();
    const [problem, setProblem] = React.useState<string | undefined>();
    const mounted = useMountedRef();

    const run = async (action: CaptureAction) => {
        setBusy(action);
        setProblem(undefined);
        try {
            if (action === 'start') {
                await store.startCapture();
            } else {
                await store.stopCapture();
            }
        } catch (error) {
            if (mounted.current) setProblem(describeCaptureError(error, action));
        } finally {
            if (mounted.current) setBusy(undefined);
        }
    };

    const running = view.phase === 'running';

    return <Root aria-label='Packet capture'>
        <Header>
            { view.phase === 'saved'
                ? <SavedIcon><CheckCircle size={24} weight='fill' aria-hidden={true} /></SavedIcon>
                : <Dot recording={running} aria-hidden={true} />
            }
            <Text>
                <div role='status'>
                    <Title>{ phaseTitle(view) }</Title>
                </div>
                <PhaseText view={view} />
            </Text>
            { running
                ? <ActionButton
                    variant='primary'
                    disabled={busy !== undefined}
                    onClick={() => run('stop')}
                >
                    { busy === 'stop' ? 'Stopping…' : 'Stop capture' }
                </ActionButton>
                : <ActionButton
                    variant='primary'
                    icon='Play'
                    disabled={busy !== undefined}
                    onClick={() => run('start')}
                >
                    { busy === 'start'
                        ? 'Starting…'
                        : view.phase === 'saved' ? 'Start a new capture' : 'Start capture'
                    }
                </ActionButton>
            }
        </Header>

        { problem && <Problem role='alert'>
            <WarningCircle size={16} weight='fill' aria-hidden={true} />
            <span>{ problem }</span>
        </Problem> }

        { view.phase !== 'idle' && <>
            <Counters>
                <Counter>
                    <dt>Packets</dt>
                    <dd>{ view.packetsText }</dd>
                </Counter>
                <Counter>
                    <dt>Size</dt>
                    <dd>{ view.sizeText }</dd>
                </Counter>
            </Counters>

            { view.path && <Location>
                <LocationLabel>{ running ? 'Saving to' : 'Saved to' }</LocationLabel>
                <PathText>{ view.path }</PathText>
                <CopyPathButton path={view.path} />
            </Location> }
        </> }

        { view.phase === 'idle' && <Notes>
            <p>HTTPS stays encrypted in the file, as it was on the wire. The decrypted requests are in View.</p>
            <p>The file holds everything the phone sent, so keep it private. A busy phone writes a lot, so stop when you are done.</p>
        </Notes> }
    </Root>;
});
