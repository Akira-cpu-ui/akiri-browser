#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Перехват TLS ClientHello.

Браузер навигируется на http://127.0.0.1:9443/cap/<label> —
сервер читает первый TLS record (ClientHello), сохраняет сырые байты
в out/<label>.bin и отвечает минимальной страницей, чтобы навигация
завершилась без ошибок.

Запуск:  python capture-server.py [port]
"""
import os
import socket
import sys
import threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9443
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

PAGE = (
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: text/html\r\n"
    "Content-Length: 14\r\n"
    "Connection: close\r\n"
    "\r\n"
    "<p>captured</p>"
).encode("ascii")


def handle(conn, addr):
    try:
        conn.settimeout(15)
        hello = b""
        # TLS record: 1 байт тип + 2 байта версия + 2 байта длина
        while len(hello) == 0:
            hdr = b""
            while len(hdr) < 5:
                chunk = conn.recv(5 - len(hdr))
                if not chunk:
                    break
                hdr += chunk
            if len(hdr) < 5:
                print(f"conn {addr[1]}: no TLS record (got {len(hdr)}B)", flush=True)
                return
            rec_len = int.from_bytes(hdr[3:5], "big")
            body = b""
            while len(body) < rec_len:
                chunk = conn.recv(rec_len - len(body))
                if not chunk:
                    break
                body += chunk
            hello = hdr + body
            # один TLS record достаточно — это и есть ClientHello
        print(f"conn {addr[1]}: TLS record {hello[0]} len {len(hello)}", flush=True)
        # Браузер не пришлёт HTTP-запрос без ServerHello, поэтому метку
        # даёт драйвер захвата (переименовывает last.bin после каждой
        # навигации). Сохраняем ClientHello сразу.
        with open(os.path.join(OUT, "last.bin"), "wb") as f:
            f.write(hello)
        print(f"captured last: {len(hello)} bytes", flush=True)
        try:
            conn.sendall(PAGE)
        except Exception:
            pass
    except Exception as e:
        print(f"conn {addr[1]} error: {e}", flush=True)
    finally:
        conn.close()


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(16)
    print(f"listening on 127.0.0.1:{PORT}", flush=True)
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle, args=(conn, addr), daemon=True).start()


if __name__ == "__main__":
    main()
