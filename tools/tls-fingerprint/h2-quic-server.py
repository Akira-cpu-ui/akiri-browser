#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Захват HTTP/2 SETTINGS и QUIC Initial.

TCP (TLS, ALPN h2) на 9443:
  - перехватывает ClientHello (сохраняет как раньше),
  - читает HTTP/2 preface + SETTINGS (сохраняет сырые кадры),
  - отвечает минимальным HTTP/2-ответом с Alt-Svc: h3=":9444",
    чтобы браузер на следующей навигации пошёл по QUIC.

UDP на 9444:
  - читает первый QUIC Initial-датаграмму, сохраняет сырые байты,
  - расшифровывает (Initial secrets по DCID), достаёт транспортные
    параметры из TLS ClientHello внутри CRYPTO-кадра.

Метки: TCP-соединение метится по пути HTTP/2 HEADERS-запроса
(после перехвата SETTINGS); QUIC-датаграммы складываются в out/<метка>-quic.bin.
"""
import hashlib
import hmac
import os
import socket
import ssl
import struct
import sys
import threading

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PORT_TCP = int(sys.argv[1]) if len(sys.argv) > 1 else 9443
PORT_UDP = PORT_TCP + 1
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
CERT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cert.pem")
KEY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "key.pem")

QUIC_V1_SALT = bytes.fromhex("38762cf7f55934b34d179ae6a4c80cadccbb7f0a")


# ---------------- QUIC ----------------

def hkdf_extract(salt, ikm):
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def hkdf_expand_label(secret, label, context, length):
    full = b"tls13 " + label
    hkdf_label = struct.pack(">H", length) + bytes([len(full)]) + full + bytes([len(context)]) + context
    out = b""
    t = b""
    i = 1
    while len(out) < length:
        t = hmac.new(secret, t + hkdf_label + bytes([i]), hashlib.sha256).digest()
        out += t
        i += 1
    return out[:length]


def quic_varint(b, o):
    first = b[o]
    ln = 1 << (first >> 6)
    val = first & 0x3F
    for i in range(1, ln):
        val = (val << 8) | b[o + i]
    return val, o + ln


def aes_ecb_mask(key, sample):
    c = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return c.update(sample) + c.finalize()


def decrypt_initial(dgram, version):
    """Декодирует QUIC Initial (v1), возвращает transport params dict."""
    if version != 0x00000001:
        return {"note": f"version {hex(version)} (не v1, расшифровка пропущена)"}
    o = 0
    b0 = dgram[o]; o += 1
    pn_len = (b0 & 0x03) + 1
    ver = int.from_bytes(dgram[o:o + 4], "big"); o += 4
    dcid_len = dgram[o]; o += 1
    dcid = dgram[o:o + dcid_len]; o += dcid_len
    scid_len = dgram[o]; o += 1
    scid = dgram[o:o + scid_len]; o += scid_len
    tok_len, o = quic_varint(dgram, o)
    o += tok_len
    length, o = quic_varint(dgram, o)
    pn_off = o
    sample = dgram[pn_off + 4:pn_off + 4 + 16]
    # ключи Initial
    initial_secret = hkdf_expand_label(hkdf_extract(QUIC_V1_SALT, dcid), "client in", b"", 32)
    key = hkdf_expand_label(initial_secret, "quic key", b"", 16)
    iv = hkdf_expand_label(initial_secret, "quic iv", b"", 12)
    hp = hkdf_expand_label(initial_secret, "quic hp", b"", 16)
    mask = aes_ecb_mask(hp, sample)
    # снимаем защиту заголовка
    hdr = bytearray(dgram[:pn_off + pn_len])
    hdr[0] ^= mask[0] & 0x0F
    for i in range(pn_len):
        hdr[pn_off + i] ^= mask[1 + i]
    pn = int.from_bytes(hdr[pn_off:pn_off + pn_len], "big")
    # расшифровка payload
    ct = dgram[pn_off + pn_len:]
    nonce = bytearray(iv)
    pnb = pn.to_bytes(4, "big")
    for i in range(4):
        nonce[i + 8] ^= pnb[i]
    aad = bytes(hdr)
    try:
        pt = AESGCM(key).decrypt(bytes(nonce), ct, aad)
    except Exception as e:
        return {"error": f"decrypt failed: {e}"}
    # кадры: ищем CRYPTO (0x06)
    fo = 0
    while fo < len(pt):
        ftype = pt[fo]; fo += 1
        if ftype == 0x06:
            off, fo = quic_varint(pt, fo)
            flen, fo = quic_varint(pt, fo)
            crypto = pt[fo:fo + flen]
            return parse_tls_transport_params(crypto)
        if ftype & 0x40:  # long frame (PADDING/other)
            ftype &= 0x3F
            if ftype == 0x00:
                continue
            return {"note": f"frame type 0x{ftype:02x}, нет CRYPTO в первом пакете"}
        llen = 1 << (ftype >> 6)
        ftype &= 0x3F
        if ftype in (0x01, 0x02, 0x03):  # PING/ACK/ACK_ECN: короткие
            continue
        flen, fo = quic_varint(pt, fo)
        fo += flen
    return {"note": "CRYPTO не найден"}


def parse_tls_transport_params(ch):
    """Из TLS ClientHello вытаскивает transport_parameters (0x0039)."""
    try:
        o = 5  # record 22 (5B) + handshake type/len (4B)
        o += 2 + 32  # legacy_version + random
        sl = ch[o]; o += 1 + sl
        cs_len = int.from_bytes(ch[o:o + 2], "big"); o += 2 + cs_len
        cl = ch[o]; o += 1 + cl
        exts_len = int.from_bytes(ch[o:o + 2], "big"); o += 2
        eo = o
        tp = None
        while eo < o + exts_len:
            t = int.from_bytes(ch[eo:eo + 2], "big")
            elen = int.from_bytes(ch[eo + 2:eo + 4], "big")
            if t == 0x0039:
                tp = ch[eo + 4:eo + 4 + elen]
                break
            eo += 4 + elen
        if tp is None:
            return {"note": "нет transport_parameters в ClientHello"}
        if len(tp) >= 4:
            tp = tp[4:]  # negotiated_version для v1
        tlen, to = quic_varint(tp, 0)
        params = {}
        end = min(to + tlen, len(tp))
        while to < end:
            pid, to = quic_varint(tp, to)
            plen, to = quic_varint(tp, to)
            val = tp[to:to + plen]
            to += plen
            params[hex(pid)] = val.hex()
        return params
    except Exception as e:
        return {"error": str(e)}


TP_NAMES = {
    "0x1": "original_destination_connection_id",
    "0x2": "max_idle_timeout",
    "0x4": "max_udp_payload_size",
    "0x5": "initial_max_data",
    "0x6": "initial_max_stream_data_bidi_local",
    "0x7": "initial_max_stream_data_bidi_remote",
    "0x8": "initial_max_stream_data_uni",
    "0x9": "initial_max_streams_bidi",
    "0xa": "initial_max_streams_uni",
    "0xb": "ack_delay_exponent",
    "0xc": "max_ack_delay",
    "0xd": "disable_active_migration",
    "0xf": "active_connection_id_limit",
    "0x10": "initial_source_connection_id",
    "0x11": "retry_source_connection_id",
}


def udp_server():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", PORT_UDP))
    print(f"udp listening on 127.0.0.1:{PORT_UDP}", flush=True)
    while True:
        data, addr = s.recvfrom(65535)
        print(f"UDP {len(data)}B from {addr}", flush=True)
        if len(data) < 5:
            continue
        b0 = data[0]
        if not (b0 & 0x80) or not (b0 & 0x40):  # не long header / не fixed bit
            continue
        version = int.from_bytes(data[1:5], "big")
        print(f"quic datagram {len(data)}B version={hex(version)}", flush=True)
        # метку берём из последней TCP-метки (драйвер переименует по месту)
        with open(os.path.join(OUT, "quic-last.bin"), "wb") as f:
            f.write(data)
        params = decrypt_initial(data, version)
        with open(os.path.join(OUT, "quic-params.txt"), "a", encoding="utf-8") as f:
            f.write(f"version={hex(version)} size={len(data)} " + repr(params) + "\n")


# ---------------- HTTP/2 ----------------

def hpack_literal(name, value):
    out = b"\x00"
    out += bytes([len(name)]) + name
    out += bytes([len(value)]) + value
    return out


def h2_headers_frame(headers):
    block = b"".join(hpack_literal(k, v) for k, v in headers)
    # кадр: [length:3][type:1][flags:1][stream:4][payload]
    return struct.pack(">I", len(block))[1:] + struct.pack(">BBI", 0x1, 0x5, 1) + block


def h2_settings_frame():
    # пустой SETTINGS: type 0x4, flags 0, stream 0, len 0
    return struct.pack(">I", 0)[1:] + struct.pack(">BBI", 0x4, 0x0, 0)


def tcp_handle(conn):
    try:
        conn.settimeout(12)
        # ---- TLS handshake (ALPN h2) ----
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(CERT, KEY)
        context.set_alpn_protocols(["h2"])
        try:
            tls = context.wrap_socket(conn, server_side=True)
        except Exception:
            return
        alpn = tls.selected_alpn_protocol()
        print(f"tls ok alpn={alpn}", flush=True)
        # ---- HTTP/2: preface + кадры (SETTINGS/WINDOW_UPDATE) ----
        data = b""
        tls.settimeout(2.5)
        try:
            while True:
                chunk = tls.recv(65536)
                if not chunk:
                    break
                data += chunk
                if len(data) > 65536:
                    break
        except Exception:
            pass
        tls.settimeout(12)
        with open(os.path.join(OUT, "h2-last.bin"), "wb") as f:
            f.write(data)
        print(f"h2 captured {len(data)}B", flush=True)
        # ---- ответ с Alt-Svc: h3=UDP-порт ----
        try:
            resp = h2_settings_frame() + h2_headers_frame([
                (b":status", b"200"),
                (b"alt-svc", b'h3=":' + str(PORT_UDP).encode() + b'"'),
                (b"content-length", b"0"),
            ])
            tls.sendall(resp)
        except Exception:
            pass
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def tcp_server():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", PORT_TCP))
    srv.listen(16)
    print(f"tcp listening on 127.0.0.1:{PORT_TCP}", flush=True)
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=tcp_handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    threading.Thread(target=udp_server, daemon=True).start()
    tcp_server()
