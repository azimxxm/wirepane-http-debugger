import * as React from 'react';
import {
    type Icon as PhosphorIconComponent,
    type IconWeight,
    ArrowCounterClockwise,
    ArrowLeft,
    ArrowLineDown,
    ArrowsIn,
    ArrowsOut,
    CaretDown,
    CaretUp,
    Check,
    Copy,
    CopySimple,
    DownloadSimple,
    Eye,
    FloppyDisk,
    FolderOpen,
    LockOpen,
    MagnifyingGlass,
    Pause,
    PencilSimple,
    Play,
    Plus,
    PushPin,
    Question,
    TextAlignLeft,
    ToggleLeft,
    ToggleRight,
    Trash,
    X
} from '@phosphor-icons/react';

import { Icon, IconProp } from '../../icons';

/*
 * Wirepane: toolbar buttons use one icon set, Phosphor, at one size. Upstream components
 * still name Font Awesome icons (['fas', 'save']); the toolbar buttons swap each one for
 * its Phosphor twin here, so those components don't need changing. Brand logos stay
 * Font Awesome, as Phosphor has no Chrome or Firefox logo.
 */

export const TOOLBAR_ICON_SIZE = 16;

interface ToolbarIconDefinition {
    component: PhosphorIconComponent;
    // The fill weight is only for things that are on
    weight?: IconWeight;
}

const TOOLBAR_ICONS: { readonly [fontAwesomeName: string]: ToolbarIconDefinition | undefined } = {
    'align-left': { component: TextAlignLeft },
    'arrow-left': { component: ArrowLeft },
    'check': { component: Check },
    'chevron-down': { component: CaretDown },
    'chevron-up': { component: CaretUp },
    'clone': { component: CopySimple },
    'compress-arrows-alt': { component: ArrowsIn },
    'copy': { component: Copy },
    'download': { component: DownloadSimple },
    'edit': { component: PencilSimple },
    'expand': { component: ArrowsOut },
    'eye': { component: Eye },
    'folder-open': { component: FolderOpen },
    'level-down-alt': { component: ArrowLineDown },
    'pause': { component: Pause },
    'play': { component: Play },
    'plus': { component: Plus },
    'question': { component: Question },
    'save': { component: FloppyDisk },
    'search': { component: MagnifyingGlass },
    'thumbtack': { component: PushPin },
    'times': { component: X },
    'toggle-off': { component: ToggleLeft },
    'toggle-on': { component: ToggleRight, weight: 'fill' },
    'trash-alt': { component: Trash },
    'undo': { component: ArrowCounterClockwise },
    'unlock': { component: LockOpen }
};

/**
 * The Phosphor icon for a Font Awesome icon name like ['fas', 'save'], if toolbars should
 * use one. Undefined for brand logos, Phosphor icon names and unknown icons.
 */
export function getToolbarIcon(icon: unknown): ToolbarIconDefinition | undefined {
    if (!Array.isArray(icon) || icon.length !== 2) return undefined;

    const [prefix, name] = icon;
    if (prefix !== 'fas' && prefix !== 'far') return undefined;
    return TOOLBAR_ICONS[name];
}

export const ToolbarIcon = (props: {
    definition: ToolbarIconDefinition,
    className?: string
}) => {
    const { component: IconComponent, weight } = props.definition;
    return <IconComponent
        className={'phosphor-icon ' + (props.className ?? '')}
        size={TOOLBAR_ICON_SIZE}
        weight={weight ?? 'regular'}
        aria-hidden={true}
    />;
};

/**
 * A drop-in for the `Icon` component in upstream cards & editors: Font Awesome names with
 * a Phosphor twin are drawn in Phosphor, everything else (brand logos, spinners) as before.
 * The title is the tooltip, and the accessible name of an icon-only button.
 */
export const UnifiedIcon = (p: {
    icon: IconProp,
    title?: string,
    className?: string,
    spin?: boolean,
    fixedWidth?: boolean,
    onClick?: (event: React.MouseEvent) => void
}) => {
    const definition = getToolbarIcon(p.icon);
    if (!definition) return <Icon
        icon={p.icon}
        title={p.title}
        className={p.className}
        spin={p.spin}
        fixedWidth={p.fixedWidth}
        onClick={p.onClick}
    />;

    const { component: IconComponent, weight } = definition;
    return <IconComponent
        className={'phosphor-icon ' + (p.className ?? '')}
        size={TOOLBAR_ICON_SIZE}
        weight={weight ?? 'regular'}
        alt={p.title}
        aria-hidden={p.title ? undefined : true}
        onClick={p.onClick}
    />;
};
