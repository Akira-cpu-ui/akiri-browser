#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Парсер TLS ClientHello → человекочитаемый отпечаток.

Использование: python parse-hello.py <file.bin> [<file2.bin> ...]
Печатает для каждого файла: версию, cipher suites, расширения в порядке
отправки, key share группы, supported groups, версии TLS, ALPN, ECH,
а также JA3/JA4-подобную сводку.
"""
import sys


def is_grease(v):
    return (v & 0x0F0F) == 0x0A0A and ((v >> 8) & 0x0F) == (v & 0x0F)


CIPHERS = {
    0x1301: "TLS_AES_128_GCM_SHA256",
    0x1302: "TLS_AES_256_GCM_SHA384",
    0x1303: "TLS_CHACHA20_POLY1305_SHA256",
    0x1304: "TLS_AES_128_CCM_SHA256",
    0x1305: "TLS_AES_128_CCM_8_SHA256",
    0x2F: "TLS_ECDHE_RSA_AES_128_GCM_SHA256",
    0x30: "TLS_ECDHE_RSA_AES_256_GCM_SHA384",
    0x33: "TLS_DHE_RSA_AES_128_GCM_SHA256",
    0x9C: "TLS_AES_128_GCM_SHA256_OLD",
    0xC02B: "TLS_ECDHE_ECDSA_AES_128_GCM_SHA256",
    0xC02C: "TLS_ECDHE_ECDSA_AES_256_GCM_SHA384",
    0xC02F: "TLS_ECDHE_RSA_AES_128_GCM_SHA256",
    0xC030: "TLS_ECDHE_RSA_AES_256_GCM_SHA384",
    0xC02D: "TLS_ECDHE_ECDSA_CHACHA20_POLY1305",
    0xCCA8: "TLS_ECDHE_RSA_CHACHA20_POLY1305",
    0xCCA9: "TLS_ECDHE_ECDSA_CHACHA20_POLY1305",
    0x009C: "TLS_RSA_WITH_AES_128_GCM_SHA256",
    0x009D: "TLS_RSA_WITH_AES_256_GCM_SHA384",
    0x3C: "TLS_RSA_WITH_AES_128_CBC_SHA256",
    0x3D: "TLS_RSA_WITH_AES_256_CBC_SHA256",
    0x35: "TLS_RSA_WITH_AES_256_CBC_SHA",
    0x2F: "TLS_RSA_WITH_AES_128_CBC_SHA",
}

GROUPS = {
    0x0017: "secp256r1",
    0x0018: "secp384r1",
    0x0019: "secp521r1",
    0x001D: "x25519",
    0x001E: "x448",
    0x0100: "ffdhe2048",
    0x0101: "ffdhe3072",
    0x0102: "ffdhe4096",
    0x6399: "x25519_kyber768 (post-quantum)",
    0x11EB: "x25519_kyber512",
    0x2F1E: "x25519_mlkem768",
    0x11EC: "x25519_kyber768_draft00",
}

EXTS = {
    0x0000: "server_name (SNI)",
    0x0001: "max_fragment_length",
    0x0005: "status_request",
    0x000A: "supported_groups",
    0x000B: "ec_point_formats",
    0x000D: "signature_algorithms",
    0x0010: "application_layer_protocol_negotiation (ALPN)",
    0x0012: "signed_certificate_timestamp",
    0x0013: "signature_algorithms_cert",
    0x0015: "padding",
    0x0016: "encrypt_then_mac",
    0x0017: "extended_master_secret",
    0x001B: "compress_certificate",
    0x0023: "session_ticket",
    0x0028: "early_data",
    0x0029: "supported_versions",
    0x002B: "pre_shared_key",
    0x002D: "psk_key_exchange_modes",
    0x0032: "renegotiation_info",
    0x0033: "key_share",
    0x0039: "quic_transport_parameters",
    0x003B: "pre_shared_key",
    0x003C: "quic_versions",
    0x4469: "application_settings",
    0x446A: "ech_outer_extensions",
    0xFE08: "encrypted_client_hello (ECH)",
    0xFF01: "renegotiation_info_old",
    0x0026: "delegated_credentials",
    0x0034: "oid_filters",
}

TLS_VERSIONS = {
    0x0301: "TLS 1.0",
    0x0302: "TLS 1.1",
    0x0303: "TLS 1.2",
    0x0304: "TLS 1.3",
}


def rd(b, o, n):
    return b[o:o + n], o + n


def u16(b, o):
    return int.from_bytes(b[o:o + 2], "big")


def parse(path):
    b = open(path, "rb").read()
    print(f"\n===== {path} ({len(b)} bytes) =====")
    if len(b) < 5:
        print("too short"); return
    rec_type, ver, rec_len = b[0], u16(b, 1), u16(b, 3)
    print(f"record: type={rec_type} legacy_version={hex(ver)} length={rec_len}")
    o = 5
    if b[o] != 1:
        print(f"not a ClientHello (handshake type {b[o]})"); return
    o += 4  # handshake type + length
    legacy_ver, o = u16(b, o), o + 2
    print(f"client_version: {TLS_VERSIONS.get(legacy_ver, hex(legacy_ver))}")
    random, o = rd(b, o, 32)
    print(f"random: {random.hex()[:16]}...")
    slen = b[o]; o += 1
    o += slen  # session_id
    cs_len, o = u16(b, o), o + 2
    ciphers = [u16(b, o + i) for i in range(0, cs_len, 2)]
    o += cs_len
    comp_len = b[o]; o += 1
    comp = list(b[o:o + comp_len]); o += comp_len
    exts_len, o = u16(b, o), o + 2
    ext_list = []
    eo = o
    while eo < o + exts_len:
        t = u16(b, eo); elen = u16(b, eo + 2)
        ext_list.append((t, b[eo + 4:eo + 4 + elen]))
        eo += 4 + elen

    def name_cs(c):
        if is_grease(c): return f"GREASE {hex(c)}"
        return CIPHERS.get(c, hex(c))

    print(f"cipher_suites ({len(ciphers)}):")
    for c in ciphers:
        print(f"  {name_cs(c)}")
    print(f"compression: {comp}")
    print(f"extensions ({len(ext_list)}, in order):")
    grease_i = 0
    for t, d in ext_list:
        if is_grease(t):
            print(f"  GREASE {hex(t)} (len {len(d)})")
            continue
        nm = EXTS.get(t, hex(t))
        extra = ""
        if t == 0x000A:  # supported_groups
            glen = u16(d, 0)
            gs = [u16(d, 2 + i) for i in range(0, glen, 2)]
            extra = " → " + ", ".join(f"{GROUPS.get(g, hex(g))}{'(GREASE)' if is_grease(g) else ''}" for g in gs)
        elif t == 0x0033:  # key_share
            glen = u16(d, 0)
            gs = []
            ko = 2
            while ko < 2 + glen:
                g = u16(d, ko); klen = u16(d, ko + 2)
                gs.append(f"{GROUPS.get(g, hex(g))}{'(GREASE)' if is_grease(g) else ''}[key {klen}B]")
                ko += 4 + klen
            extra = " → " + ", ".join(gs)
        elif t == 0x0029:  # supported_versions
            vl = d[0]
            vs = [u16(d, 1 + i) for i in range(0, vl, 2)]
            extra = " → " + ", ".join(TLS_VERSIONS.get(v, hex(v)) for v in vs)
        elif t == 0x0010:  # ALPN
            al = d[0]
            ao = 1
            protos = []
            while ao < 1 + al:
                pl = d[ao]; protos.append(d[ao + 1:ao + 1 + pl].decode("latin1")); ao += 1 + pl
            extra = " → " + ", ".join(protos)
        elif t == 0x000D:  # sigalgs
            sl = u16(d, 0)
            sigs = [hex(u16(d, 2 + i)) for i in range(0, sl, 2)]
            extra = f" → {len(sigs)} algs: " + ", ".join(sigs)
        elif t == 0xFE08:
            extra = " → **ECH PRESENT**"
        elif t == 0x002D:  # psk_key_exchange_modes
            modes = {0: "psk_ke", 1: "psk_dhe_ke"}
            extra = " → " + ", ".join(modes.get(x, hex(x)) for x in d[1:])
        elif t == 0x0012:  # SCT
            extra = " → present"
        print(f"  {nm}{extra}")
    # JA3-подобная сводка
    ja3_cs = ",".join(hex(c)[2:].upper() for c in ciphers)
    ja3_ext = ",".join(hex(t)[2:].upper() for t, _ in ext_list if not is_grease(t))
    sigs = []
    for t, d in ext_list:
        if t == 0x000D:
            sl = u16(d, 0)
            sigs = [hex(u16(d, 2 + i)) for i in range(0, sl, 2)]
    # JA4: tls_version,cipher,ext_count,sigalgs,alpn
    alpn = ""
    for t, d in ext_list:
        if t == 0x0010 and len(d) > 1:
            alpn = d[2:2 + d[1]].decode("latin1", "replace")
    sv = ""
    for t, d in ext_list:
        if t == 0x0029 and len(d) > 2:
            sv = hex(u16(d, 1))
    first_cs = ciphers[0] if ciphers else 0
    ja4 = f"t{sv[2:]}_c{hex(first_cs)[2:].upper()}_e{len(ext_list)}_{len(sigs)}_{alpn or '00'}"
    print(f"JA3: {legacy_ver:x},{ja3_cs},{ja3_ext}")
    print(f"JA4: {ja4}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for p in sys.argv[1:]:
        parse(p)
