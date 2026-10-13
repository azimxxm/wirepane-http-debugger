# ClientHello fixtures for the JA4 tests

Each `.hex` file holds the first bytes a real TLS client sent to a local listener, as one line of hex.
`src/features/fingerprint.rs` parses them in `real_hellos_from_local_clients`.

| File                                   | Client (macOS, 2026-10-13)                                      |
| -------------------------------------- | --------------------------------------------------------------- |
| `chrome-154.hex`                       | Google Chrome 154 headless, `https://example.com/` (h2, ECH, GREASE) |
| `chrome-154-second-connection.hex`     | The same Chrome, a new connection: other GREASE, other extension order and padding, same JA4 |
| `openssl-3.6.5.hex`                    | `openssl s_client -servername example.com -alpn h2,http/1.1` (Homebrew) |
| `libressl-3.3.6.hex`                   | `/usr/bin/openssl s_client -servername www.example.org` (no ALPN) |
| `curl-8.7.1.hex`                       | `/usr/bin/curl --http2` (LibreSSL)                              |
| `python-3.14-ssl.hex`                  | Python's `ssl` module, no ALPN                                  |
| `node-24-tls.hex`                      | Node 24 `tls.connect` with `ALPNProtocols: ['h2', 'http/1.1']`  |

The expected JA4 strings in the test were computed by `ja4_reference.py`, a separate implementation of
the FoxIO spec in Python, not by the Rust code. To add a client: `python3 capture_hello.py <port> <out.hex>`,
point the client at `127.0.0.1:<port>` (use `--resolve` or a host-resolver rule to get a real SNI), then
`python3 ja4_reference.py <out.hex>`.
