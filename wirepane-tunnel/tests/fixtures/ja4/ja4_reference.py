# An independent JA4 (TCP/TLS) implementation written from the FoxIO spec, to check the Rust code.
import hashlib, struct, sys

def grease(v): return (v & 0x0f0f) == 0x0a0a and (v >> 8) == (v & 0xff)

def parse(data):
    assert data[0] == 0x16 and data[1] == 3
    rec_len = struct.unpack(">H", data[3:5])[0]
    hs = data[5:5 + rec_len]
    assert hs[0] == 1
    body_len = int.from_bytes(hs[1:4], "big")
    body = hs[4:4 + body_len]
    assert len(body) == body_len, "hello spans records (not handled by the reference)"
    i = 0
    legacy = struct.unpack(">H", body[i:i+2])[0]; i += 2 + 32
    sid = body[i]; i += 1 + sid
    cl = struct.unpack(">H", body[i:i+2])[0]; i += 2
    ciphers = [struct.unpack(">H", body[i+k:i+k+2])[0] for k in range(0, cl, 2)]; i += cl
    cm = body[i]; i += 1 + cm
    exts = []
    if i < len(body):
        el = struct.unpack(">H", body[i:i+2])[0]; i += 2
        end = i + el
        while i < end:
            t, l = struct.unpack(">HH", body[i:i+4]); i += 4
            exts.append((t, body[i:i+l])); i += l
    return legacy, ciphers, exts

def ja4(data):
    legacy, ciphers, exts = parse(data)
    ciphers = [c for c in ciphers if not grease(c)]
    ext_types = [t for t, _ in exts if not grease(t)]
    sni = any(t == 0 for t, _ in exts)
    alpn_vals, sigalgs, versions, server_name = [], [], [], None
    for t, d in exts:
        if t == 16:
            ll = struct.unpack(">H", d[:2])[0]; j = 2
            while j < 2 + ll:
                n = d[j]; alpn_vals.append(d[j+1:j+1+n]); j += 1 + n
        elif t == 13:
            ll = struct.unpack(">H", d[:2])[0]
            sigalgs = [struct.unpack(">H", d[2+k:4+k])[0] for k in range(0, ll, 2)]
        elif t == 43:
            ll = d[0]
            versions = [struct.unpack(">H", d[1+k:3+k])[0] for k in range(0, ll, 2)]
        elif t == 0:
            ll = struct.unpack(">H", d[:2])[0]
            if ll:
                nl = struct.unpack(">H", d[3:5])[0]
                server_name = d[5:5+nl].decode("ascii", "replace")
    sigalgs = [x for x in sigalgs if not grease(x)]
    versions = [v for v in versions if not grease(v)]
    v = max(versions) if versions else legacy
    ver = {0x0304: "13", 0x0303: "12", 0x0302: "11", 0x0301: "10", 0x0300: "s3", 0x0200: "s2"}.get(v, "00")
    if alpn_vals and alpn_vals[0]:
        a = alpn_vals[0]
        if chr(a[0]).isalnum() and chr(a[-1]).isalnum() and a[0] < 128 and a[-1] < 128:
            alpn = chr(a[0]) + chr(a[-1])
        else:
            h = a.hex(); alpn = h[0] + h[-1]
    else:
        alpn = "00"
    part_a = f"t{ver}{'d' if sni else 'i'}{min(len(ciphers), 99):02d}{min(len(ext_types), 99):02d}{alpn}"
    cs = ",".join(f"{c:04x}" for c in sorted(ciphers))
    es = ",".join(f"{t:04x}" for t in sorted(t for t in ext_types if t not in (0, 16)))
    if sigalgs:
        es += "_" + ",".join(f"{s:04x}" for s in sigalgs)
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()[:12] if s else "0" * 12
    return f"{part_a}_{h(cs)}_{h(es)}", server_name, [x.decode("latin1") for x in alpn_vals], f"{part_a}_{cs}_{es}"

if __name__ == "__main__":
    for path in sys.argv[1:]:
        data = bytes.fromhex(open(path).read().strip())
        j, sni, alpn, raw = ja4(data)
        print(f"{path}: len={len(data)} ja4={j} sni={sni} alpn={alpn}")
        print("   raw:", raw)
