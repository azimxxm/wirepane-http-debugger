// Stands in for the server in the "the helper can't outlive the server" test: it starts the
// wireguard-vpn interceptor, says so, and then waits to be killed.
// Arguments: <config folder> <proxy port>
import type { HtkConfig } from '../../src/config';
import { WireGuardVpnInterceptor } from '../../src/interceptors/wireguard-vpn';

const [configPath, proxyPort] = process.argv.slice(2);

const interceptor = new WireGuardVpnInterceptor({ configPath } as HtkConfig);

interceptor.activate(Number(proxyPort), { action: 'start' }).then(
    () => {
        console.log('started');
        setInterval(() => {}, 1000); // Keep the process alive until the test kills it
    },
    (error) => {
        console.error(error);
        process.exit(1);
    }
);
