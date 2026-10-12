import { styled } from '../../styles';

// Wirepane: a hostname exactly as it is, in the data font, so copying it gives the real
// name. Pills used to space out its dots ("example . com").
export const HostnameText = styled.span`
    font-family: ${p => p.theme.monoFontFamily};
    font-weight: 500; /* DM Mono's heaviest real weight, so a bold pill doesn't fake one */
    word-spacing: normal;
`;
