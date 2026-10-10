import * as React from 'react';
import { Link } from '@reach/router';

import { styled, css } from '../../styles';
import { PhosphorIcon } from '../../icons';
import { formatShortcut } from '../../util/shortcuts';

import { ActionButton } from '../common/action-button';

type StepState = 'done' | 'current' | 'next';

const StepsStrip = styled.ol`
    min-height: 64px;
    box-sizing: border-box;
    padding: 10px 16px;

    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;
`;

const Step = styled.li<{ state: StepState }>`
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;

    color: ${p => p.state === 'next'
        ? p.theme.mainLowlightColor
        : p.theme.mainColor
    };
`;

const StepArrow = styled.span`
    display: flex;
    margin-right: 4px;
    color: ${p => p.theme.containerWatermark};
`;

const StepBadge = styled.span<{ state: StepState }>`
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    box-sizing: border-box;
    border-radius: 50%;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;

    ${p => p.state === 'current'
        ? css`
            background-color: ${p => p.theme.popColor};
            color: ${p => p.theme.popOverlayColor};
        `
        : p.state === 'done'
        ? css`
            border: 1.5px solid ${p => p.theme.popColor};
            color: ${p => p.theme.popColor};
        `
        : css`
            border: 1px solid ${p => p.theme.inputBorder};
            color: ${p => p.theme.mainLowlightColor};
        `
    }
`;

const StepTitle = styled.span`
    font-size: ${p => p.theme.textSize};
    font-weight: 600;
    white-space: nowrap;
`;

const VisuallyHidden = styled.span`
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
`;

const StepLinks = styled.span`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const StepLink = styled(Link)`
    color: ${p => p.theme.linkColor};
    text-decoration: none;

    &:hover {
        text-decoration: underline;
    }
`;

const FlowStep = (props: {
    number: number,
    state: StepState,
    title: string,
    children?: React.ReactNode
}) => <Step state={props.state} aria-current={props.state === 'current' ? 'step' : undefined}>
    { props.number > 1 && <StepArrow aria-hidden={true}>
        <PhosphorIcon icon='ArrowRight' size={16} />
    </StepArrow> }
    <StepBadge state={props.state} aria-hidden={true}>{
        props.state === 'done'
            ? <PhosphorIcon icon='Check' size={14} weight='bold' />
            : props.number
    }</StepBadge>
    <StepTitle>
        { props.title }
        { props.state === 'done' && <VisuallyHidden> (done)</VisuallyHidden> }
    </StepTitle>
    { props.children }
</Step>;

/**
 * "Connect → Inspect → Mock or replay": the whole Wirepane flow, as a strip at the
 * top of the Intercept page. Once a client is connected, the second step becomes
 * the way forward.
 */
export const FlowSteps = (props: {
    hasClients: boolean,
    requestCount: number,
    onViewRequests: () => void
}) => {
    const { hasClients, requestCount } = props;

    return <StepsStrip aria-label='How Wirepane works'>
        <FlowStep number={1} state={hasClients ? 'done' : 'current'} title='Connect a source' />

        <FlowStep number={2} state={hasClients ? 'current' : 'next'} title='Inspect traffic'>
            { hasClients
                ? <ActionButton
                    variant='primary'
                    icon='Rows'
                    shortcut='Cmd+2'
                    title='Show the captured requests'
                    onClick={props.onViewRequests}
                >
                    View { requestCount.toLocaleString() } request{ requestCount === 1 ? '' : 's' }
                </ActionButton>
                : <StepLinks>
                    <StepLink to='/view'>View { formatShortcut('Cmd+2') }</StepLink>
                </StepLinks>
            }
        </FlowStep>

        <FlowStep number={3} state='next' title='Mock or replay'>
            <StepLinks>
                <StepLink to='/modify'>Modify { formatShortcut('Cmd+3') }</StepLink>
                ·
                <StepLink to='/send'>Send { formatShortcut('Cmd+4') }</StepLink>
            </StepLinks>
        </FlowStep>
    </StepsStrip>;
};
