import { styled } from '../../../styles';

// The scrolling content of a request pane tab. Its left edge lines up with the tab labels.
export const PanelScroll = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 20px;

    display: flex;
    flex-direction: column;
    gap: 16px;
`;

export const PanelSection = styled.section`
    display: flex;
    flex-direction: column;
    gap: 8px;
`;

export const PanelSectionHeading = styled.h2`
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

export const PanelNote = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.5;
    color: ${p => p.theme.containerWatermark};

    code {
        font-family: ${p => p.theme.monoFontFamily};
        color: ${p => p.theme.mainLowlightColor};
    }
`;
