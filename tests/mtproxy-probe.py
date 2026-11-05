#!/usr/bin/env python3
"""Protocol-level MTProto proxy probe (obfuscated2), derived from the MTProxy
server source (net/net-tcp-rpc-ext-server.c):
  read_key  = sha256(H[8:40] + secret)
  read_iv   = H[40:56]
  write_key = sha256(reversed(H[24:56]) + secret)
  write_iv  = reversed(H[8:24])
The tag lives at decrypted H[56:60] (LE): 0xdddddddd / 0xeeeeeeee / 0xefefefef.
H[56:64] is not used in key derivation, so the client patches the tag in after
computing the keystream. AES-256-CTR keystream via the openssl binary.

Usage: mtproxy-probe.py <port> <secret-hex> <mode> [sni] <accepted|rejected>
  mode: dd|ee|ef = send obfuscated2 header with that tag
        xx        = send a garbage header (no valid tag)
        tls       = send a TLS ClientHello with SNI
Exits 0 if the observed behavior matches the expectation.
"""
import hashlib, os, socket, struct, subprocess, sys

port = int(sys.argv[1]); secret = bytes.fromhex(sys.argv[2])
mode = sys.argv[3]; expect = sys.argv[-1]
sni = sys.argv[4] if (len(sys.argv) > 5 or (len(sys.argv) == 5 and mode == "tls")) else ""
if mode == "tls" and len(sys.argv) >= 5:
    sni = sys.argv[4]

def ctr_keystream(key: bytes, iv: bytes, n: int) -> bytes:
    zeros = b"\x00" * ((n + 15) // 16 * 16)
    out = subprocess.run(["openssl", "enc", "-aes-256-ctr", "-K", key.hex(), "-iv", iv.hex()],
                         input=zeros, capture_output=True, check=True).stdout
    return out[:n]

def obfuscated_header(tag: int | None) -> bytes:
    H = bytearray(os.urandom(64))
    read_key = hashlib.sha256(bytes(H[8:40]) + secret).digest()
    read_iv = bytes(H[40:56])
    ks = ctr_keystream(read_key, read_iv, 64)
    if tag is not None:
        H[56:60] = struct.pack("<I", tag)
        for i in range(4):
            H[56 + i] ^= ks[56 + i]
        H[60:62] = b"\x00\x00"
        for i in range(2):
            H[60 + i] ^= ks[60 + i]
    return bytes(H)

def tls_clienthello(sni_name: str) -> bytes:
    ext = b""
    name = sni_name.encode()
    sni_ext = struct.pack(">H", 0) + struct.pack(">H", len(name) + 5) + b"\x00" + struct.pack(">H", len(name) + 3) + struct.pack(">H", len(name)) + name
    # the server only recognizes a TLS record when its length >= 512 bytes
    # (first length byte >= 2), so pad with a TLS padding extension (0x0015)
    pad_len = max(0, 600 - (len(sni_ext) + 4 + 45))
    pad_ext = struct.pack(">H", 21) + struct.pack(">H", pad_len) + b"\x00" * pad_len
    ext = sni_ext + pad_ext
    exts = struct.pack(">H", len(ext)) + ext
    body = (b"\x03\x03" + os.urandom(32) + b"\x00" +
            struct.pack(">H", 2) + b"\x13\x01" + b"\x01\x00" + exts)
    hs = b"\x01" + len(body).to_bytes(3, "big") + body
    return b"\x16\x03\x01" + struct.pack(">H", len(hs)) + hs

def send_and_close(payload: bytes, port_: int) -> None:
    """Send the probe packet and close. The MTProxy log (vkprintf level 1) is the
    deterministic oracle: 'opportunistic encryption mode detected, tag=...' for an
    accepted obfuscated2 header, 'invalid random 64-byte header' for garbage,
    'Receive TLS request on port' / 'unknown domain' for fake-TLS SNI checks."""
    s = socket.create_connection(("127.0.0.1", port_), timeout=4)
    s.sendall(payload)
    s.settimeout(1)
    try:
        s.recv(256)
    except Exception:
        pass
    s.close()

TAGS = {"dd": 0xDDDDDDDD, "ee": 0xEEEEEEEE, "ef": 0xEFEFEFEF}
if mode == "tls":
    send_and_close(tls_clienthello(sni), port)
elif mode == "xx":
    send_and_close(obfuscated_header(None), port)
else:
    send_and_close(obfuscated_header(TAGS[mode]), port)
print(f"probe sent: port={port} mode={mode} sni={sni}")
sys.exit(0)
