# Listens on 127.0.0.1:<port>, saves the first bytes of the first connection as hex, then exits.
import socket, sys, time

port, out = int(sys.argv[1]), sys.argv[2]
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", port))
srv.listen(4)
srv.settimeout(20)
conn, _ = srv.accept()
conn.settimeout(1.0)
data = b""
deadline = time.time() + 2.0
while time.time() < deadline:
    try:
        chunk = conn.recv(65536)
    except socket.timeout:
        break
    if not chunk:
        break
    data += chunk
    # a complete first record is enough
    if len(data) >= 5 and len(data) >= 5 + int.from_bytes(data[3:5], "big"):
        break
open(out, "w").write(data.hex() + "\n")
conn.close()
srv.close()
print(f"captured {len(data)} bytes -> {out}")
