import * as React from 'react';

import { styled } from '../../styles';
import { useHotkeys } from '../../util/ui';

import { UnstyledButton } from './inputs';

/**
 * The parts of the collapsible, resizable side panels on the left of a page: the
 * Collections panel in Send and the Devices panel in View.
 */

// The same shortcut shows & hides whichever page's side panel is open
export const TOGGLE_SIDE_PANEL_SHORTCUT = 'Cmd+Alt+S';

export const PanelRoot = styled.aside`
    position: relative;
    flex-shrink: 0;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;

    display: flex;
    flex-direction: column;

    background-color: ${p => p.theme.mainLowlightBackground};
    border-right: 1px solid ${p => p.theme.containerBorder};
`;

export const PanelHeader = styled.header`
    flex-shrink: 0;
    height: 38px;
    padding: 0 6px 0 14px;

    display: flex;
    align-items: center;
    gap: 2px;

    h2 {
        flex: 1 1 auto;
        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }
`;

export const PanelToolButton = styled(UnstyledButton)`
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

export const PanelScroller = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
`;

export const CollapsedPanelStrip = styled.aside`
    flex-shrink: 0;
    width: 40px;
    height: 100%;
    box-sizing: border-box;
    padding-top: 5px;

    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;

    background-color: ${p => p.theme.mainLowlightBackground};
    border-right: 1px solid ${p => p.theme.containerBorder};
`;

const ResizeHandle = styled.div`
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    z-index: 5;
    cursor: col-resize;

    &:hover, &:focus-visible, &.dragging {
        background: linear-gradient(90deg, transparent 3px, ${p => p.theme.focusRing} 3px, ${p => p.theme.focusRing} 5px, transparent 5px);
    }

    &:focus-visible {
        outline: none;
    }
`;

export interface PanelSizing {
    width: number;
    minWidth: number;
    maxWidth: number;
    defaultWidth: number;
    // Called once a drag ends (or for each keyboard step), with an unclamped width
    setWidth: (width: number) => void;
}

// Drags the panel's right edge to resize it. The width is kept when the drag ends.
export function usePanelResize(sizing: PanelSizing) {
    const [dragWidth, setDragWidth] = React.useState<number | undefined>();
    const { width, minWidth, maxWidth, defaultWidth, setWidth } = sizing;
    const clamp = (value: number) => Math.min(maxWidth, Math.max(minWidth, value));

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const handle = event.currentTarget;
        const startX = event.clientX;
        const startWidth = width;

        handle.setPointerCapture(event.pointerId);
        handle.classList.add('dragging');

        const onMove = (moveEvent: PointerEvent) => setDragWidth(clamp(startWidth + moveEvent.clientX - startX));
        const onUp = (upEvent: PointerEvent) => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.classList.remove('dragging');
            setWidth(clamp(startWidth + upEvent.clientX - startX));
            setDragWidth(undefined);
        };

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') setWidth(clamp(width - step));
        else if (event.key === 'ArrowRight') setWidth(clamp(width + step));
        else return;
        event.preventDefault();
    };

    return {
        width: dragWidth ?? width,
        handleProps: {
            onPointerDown,
            onKeyDown,
            onDoubleClick: () => setWidth(defaultWidth)
        }
    };
}

// The draggable right edge, which also takes ← and → when focused
export const PanelResizeHandle = (props: {
    label: string,
    width: number,
    sizing: PanelSizing,
    handleProps: ReturnType<typeof usePanelResize>['handleProps']
}) => <ResizeHandle
    role='separator'
    aria-orientation='vertical'
    aria-label={props.label}
    aria-valuenow={props.width}
    aria-valuemin={props.sizing.minWidth}
    aria-valuemax={props.sizing.maxWidth}
    tabIndex={0}
    title='Drag to resize. Double-click to reset.'
    {...props.handleProps}
/>;

export const PanelToggleShortcut = (props: { onToggle: () => void }) => {
    useHotkeys('Ctrl+Alt+s, Cmd+Alt+s', (event) => {
        event.preventDefault();
        props.onToggle();
    }, [props.onToggle]);
    return null;
};
