#!/usr/bin/env node
'use strict';

// A stand-in for the wirepane-tunnel binary, for the wireguard-vpn interceptor tests.
// It speaks the same JSON-lines protocol (see docs/plans/2026-10-12-iphone-fixes-and-vpn.md)
// but moves no packets. Env vars switch on the behaviours the tests need:
//
//   STUB_LOG                  file that gets one JSON line per start / command / stdin EOF
//   STUB_HANDSHAKE_MS         after add-peer, send a "peer" event for it after this many ms
//   STUB_NO_SET_SOCKS         answer set-socks with an error, like a helper that can't switch
//   STUB_FAIL_START           print an error and exit 1 instead of becoming ready
//   STUB_IGNORE_STDIN_EOF     keep running after stdin closes (only signals stop it)
//   STUB_NOISY_ERROR          send an unrelated error event just before every reply
//   STUB_LIST_PEERS_ERROR     answer list-peers with an error
//   STUB_LATE_PEER            shortly after ready, add a peer behind the parent's back and
//                             send a "peer" event for it
//
// A peer named "crash-me" makes it exit with code 3 right after answering add-peer.

const fs = require('fs');

const args = process.argv.slice(2);
const argValue = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
};

const listen = argValue('--wireguard');
const statePath = argValue('--state');
const socksAddr = argValue('--socks');
const endpointHost = argValue('--endpoint-host');
const listenPort = listen ? listen.split(':').pop() : '';

const log = (entry) => {
    if (!process.env.STUB_LOG) return;
    fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\n');
};
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');

log({ type: 'start', args });

if (process.env.STUB_FAIL_START) {
    emit({ event: 'error', message: `failed to bind UDP ${listen}: address in use` });
    process.exit(1);
}

// The state file keeps the peers between runs, like the real helper's
let state = { nextPeer: 1, peers: [] };
if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} else {
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });

// Handshakes only live as long as the process
const activity = new Map();

const describePeer = (peer) => ({
    peer: peer.peer,
    name: peer.name,
    kind: peer.kind,
    tunnelIp: peer.tunnelIp,
    endpoint: activity.get(peer.peer)?.endpoint ?? null,
    lastHandshake: activity.get(peer.peer)?.lastHandshake ?? null
});

const buildConfig = (peer) => [
    '[Interface]',
    'PrivateKey = STUBPRIVATEKEY=',
    `Address = ${peer.tunnelIp}/32`,
    'DNS = 10.73.0.53',
    '',
    '[Peer]',
    'PublicKey = STUBPUBLICKEY=',
    'AllowedIPs = 0.0.0.0/0, ::/0',
    `Endpoint = ${endpointHost}:${listenPort}`,
    'PersistentKeepalive = 25',
    ''
].join('\n');

const handlers = {
    'add-peer': (cmd) => {
        const number = state.nextPeer++;
        const peer = {
            peer: `p${number}`,
            name: cmd.name,
            kind: cmd.kind,
            tunnelIp: `10.73.0.${number + 1}`
        };
        state.peers.push(peer);
        saveState();

        emit({ event: 'peer-added', ...describePeer(peer), config: buildConfig(peer) });

        if (process.env.STUB_HANDSHAKE_MS) {
            setTimeout(() => {
                const handshake = {
                    endpoint: '192.168.0.199:61234',
                    lastHandshake: Date.now()
                };
                activity.set(peer.peer, handshake);
                emit({ event: 'peer', peer: peer.peer, ...handshake });
            }, Number(process.env.STUB_HANDSHAKE_MS));
        }

        if (cmd.name === 'crash-me') setTimeout(() => process.exit(3), 20);
    },

    'remove-peer': (cmd) => {
        if (!state.peers.some((peer) => peer.peer === cmd.peer)) {
            return emit({ event: 'error', message: `no such peer: ${cmd.peer}` });
        }
        state.peers = state.peers.filter((peer) => peer.peer !== cmd.peer);
        saveState();
        emit({ event: 'peer-removed', peer: cmd.peer });
    },

    'list-peers': () => {
        if (process.env.STUB_LIST_PEERS_ERROR) {
            return emit({ event: 'error', message: 'cannot list peers right now' });
        }
        emit({ event: 'peers', peers: state.peers.map(describePeer) });
    },

    'set-socks': (cmd) => {
        if (process.env.STUB_NO_SET_SOCKS) {
            return emit({ event: 'error', message: 'set-socks is not supported' });
        }
        emit({ event: 'socks-set', addr: cmd.addr });
    }
};

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;

        const cmd = JSON.parse(line);
        log({ type: 'cmd', cmd });

        if (process.env.STUB_NOISY_ERROR) {
            emit({ event: 'error', message: 'upstream connection failed' });
        }

        const handler = handlers[cmd.cmd];
        if (handler) handler(cmd);
        else emit({ event: 'error', message: `unknown command: ${cmd.cmd}` });
    }
});

process.stdin.on('end', () => {
    log({ type: 'stdin-eof' });
    if (process.env.STUB_IGNORE_STDIN_EOF) {
        setInterval(() => {}, 1000); // Stay alive, so only a signal can stop it
        return;
    }
    process.exit(0);
});

// Things the interceptor has to ignore: stray output, and events it has no use for
process.stdout.write('this line is not JSON\n');
emit({ event: 'ready', listen, publicKey: 'STUBPUBLICKEY=' });
emit({ event: 'dns', peer: 'p1', name: 'example.com', qtype: 'A', rcode: 'NOERROR', answers: [], ms: 3 });
emit({ event: 'quic', peer: 'p1', dst: '1.2.3.4:443', action: 'blocked' });

if (process.env.STUB_LATE_PEER) {
    setTimeout(() => {
        state.peers.push({ peer: 'p9', name: 'late phone', kind: 'wireguard', tunnelIp: '10.73.0.9' });
        saveState();
        const handshake = { endpoint: '192.168.0.50:5555', lastHandshake: Date.now() };
        activity.set('p9', handshake);
        emit({ event: 'peer', peer: 'p9', ...handshake });
    }, 100);
}

// socksAddr is only logged: the stub has no proxy to dial
log({ type: 'ready', socksAddr });
