import * as React from 'react';

import { Icon } from '../../icons';
import { TrafficSource } from '../../model/http/sources';

/**
 * A client's icon at the surrounding font size, for both FontAwesome brand icons
 * and Phosphor icons (e.g. the terminal icon used for curl).
 */
export const ClientIcon = (props: {
    source: TrafficSource,
    className?: string
}) => {
    const { icon } = props.source;
    const isFontAwesome = Array.isArray(icon.icon);

    return <Icon
        className={props.className}
        title={props.source.summary}
        {...icon}
        size={isFontAwesome ? undefined : '1.15em'}
        fixedWidth={isFontAwesome}
    />;
};
