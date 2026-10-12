import * as React from 'react';

import { styled } from '../../styles';

import type { HarImportProblem } from '../../model/events/har-files';

import { ActionButton } from './action-button';
import { CollectionDialog } from '../collections/dialog-frame';

const ProblemMessage = styled.p`
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
`;

/**
 * Why a HAR file couldn't be imported, from View's toolbar, ⌘K or the menu bar.
 */
export const HarImportProblemDialog = (props: { problem: HarImportProblem, onClose: () => void }) => {
    // <dialog> focuses its [autofocus] element when it opens:
    const focusOnOpen = React.useCallback((button: HTMLButtonElement | null) => {
        button?.setAttribute('autofocus', '');
    }, []);

    return <CollectionDialog
        title={props.problem.title}
        width={480}
        onClose={props.onClose}
        footer={<ActionButton ref={focusOnOpen} variant='primary' onClick={props.onClose}>OK</ActionButton>}
    >
        <ProblemMessage>{ props.problem.message }</ProblemMessage>
    </CollectionDialog>;
};
