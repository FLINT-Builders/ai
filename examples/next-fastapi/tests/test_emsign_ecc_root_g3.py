"""The example FastAPI app must not trust emSign ECC Root CA - G3.

`api/index.py` builds an OpenAI client with no custom TLS context. That client
verifies outbound HTTPS, including `stream_text`'s chat completion call, with
the CA bundle from the pinned certifi package. These tests fail while that
bundle still trusts emSign ECC Root CA - G3.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import ssl
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import certifi
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

# Public SHA-256 of the self-signed "emSign ECC Root CA - G3" certificate that
# certifi 2024.7.4 bundles. This is the certificate's own fingerprint, not a secret.
EMSIGN_ECC_ROOT_G3_SHA256 = bytes.fromhex(
    "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b"
)
PLACEHOLDER_API_KEY = "placeholder"
EXAMPLE_ROOT = Path(__file__).resolve().parents[1]


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def _key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def _sign_ca(
    subject_key: ec.EllipticCurvePrivateKey,
    issuer_key: ec.EllipticCurvePrivateKey,
    subject: x509.Name,
    issuer: x509.Name,
    *,
    path_length: int | None,
) -> x509.Certificate:
    now = datetime.now(timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(subject_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=path_length), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                key_cert_sign=True,
                crl_sign=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(subject_key.public_key()),
            critical=False,
        )
    )
    return builder.sign(issuer_key, hashes.SHA256())


def _sign_leaf(
    subject_key: ec.EllipticCurvePrivateKey,
    issuer_key: ec.EllipticCurvePrivateKey,
    issuer: x509.Name,
    san_ip: ipaddress.IPv4Address,
) -> x509.Certificate:
    now = datetime.now(timezone.utc)
    return (
        x509.CertificateBuilder()
        .subject_name(_name("local-chat"))
        .issuer_name(issuer)
        .public_key(subject_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_cert_sign=False,
                crl_sign=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(san_ip)]), critical=False)
        .sign(issuer_key, hashes.SHA256())
    )


def _pem_cert(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


def _pem_key(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )


def _revoke(issuer: x509.Certificate, issuer_key: ec.EllipticCurvePrivateKey, serial: int) -> x509.CertificateRevocationList:
    now = datetime.now(timezone.utc)
    revoked = (
        x509.RevokedCertificateBuilder()
        .serial_number(serial)
        .revocation_date(now)
        .build()
    )
    return (
        x509.CertificateRevocationListBuilder()
        .issuer_name(issuer.subject)
        .last_update(now)
        .next_update(now + timedelta(days=1))
        .add_revoked_certificate(revoked)
        .sign(private_key=issuer_key, algorithm=hashes.SHA256())
    )


def _write_server_material(
    directory: Path,
    leaf: x509.Certificate,
    leaf_key: ec.EllipticCurvePrivateKey,
    intermediate: x509.Certificate,
) -> tuple[Path, Path]:
    cert_path = directory / "server.pem"
    key_path = directory / "server.key"
    # Leaf first, then the intermediate the client must use to reach the root.
    cert_path.write_bytes(_pem_cert(leaf) + _pem_cert(intermediate))
    key_path.write_bytes(_pem_key(leaf_key))
    return cert_path, key_path


def _read_http_request(conn: ssl.SSLSocket) -> bytes:
    data = b""
    conn.settimeout(10)
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(8192)
        if not chunk:
            break
        data += chunk
    header, _, body = data.partition(b"\r\n\r\n")
    length = 0
    for line in header.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1].strip())
    while len(body) < length:
        chunk = conn.recv(8192)
        if not chunk:
            break
        body += chunk
    return header + b"\r\n\r\n" + body


def _sse_response() -> bytes:
    chunk = {
        "id": "chatcmpl-local",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-4o",
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": "ok"},
                "finish_reason": None,
            }
        ],
    }
    done = {
        "id": "chatcmpl-local",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-4o",
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }
        ],
    }
    payload = (
        f"data: {json.dumps(chunk)}\n\n"
        f"data: {json.dumps(done)}\n\n"
        "data: [DONE]\n\n"
    ).encode()
    return (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/event-stream\r\n"
        b"Cache-Control: no-cache\r\n"
        + f"Content-Length: {len(payload)}\r\n".encode()
        + b"Connection: close\r\n\r\n"
        + payload
    )


def _serve(cert_path: Path, key_path: Path, captured: dict[str, bytes], ready: threading.Event) -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(15)
    captured["port"] = server.getsockname()[1]
    ready.set()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    try:
        raw, _ = server.accept()
    except socket.timeout:
        server.close()
        return
    try:
        with context.wrap_socket(raw, server_side=True) as conn:
            captured["request"] = _read_http_request(conn)
            conn.sendall(_sse_response())
    except ssl.SSLError:
        # The client aborts when it does not trust the presented chain.
        return
    finally:
        server.close()


def _header_value(request: bytes, name: str) -> str | None:
    header = request.split(b"\r\n\r\n", 1)[0].decode()
    prefix = name.lower() + ":"
    for line in header.split("\r\n"):
        if line.lower().startswith(prefix):
            return line.split(":", 1)[1].strip()
    return None


def _trust_anchors(context: ssl.SSLContext) -> list[x509.Certificate]:
    return [
        x509.load_der_x509_certificate(der)
        for der in context.get_ca_certs(binary_form=True)
    ]


def _app_ssl_context(client: object) -> ssl.SSLContext:
    # OpenAI._client is the httpx.Client created in SyncAPIClient.__init__.
    # HTTPTransport stores the SSL context on the httpcore pool it wraps.
    http = client._client  # type: ignore[attr-defined]
    return http._transport._pool._ssl_context


def test_stream_text_does_not_trust_emsign_ecc_root_g3(tmp_path: Path) -> None:
    """A chat completion must reject peers chaining to emSign ECC Root CA - G3.

    The request path is the one `stream_text` runs: `OpenAI()` with the default
    httpx transport, then `chat.completions.create`. A root appended to the
    certifi bundle that transport loads is enough for that call to complete and
    for the peer to see the Authorization header. The same trust store must not
    contain emSign ECC Root CA - G3, including when an intermediate under a
    trusted root has been revoked and the client never consults a CRL.
    """
    bundle_path = Path(certifi.where())
    original_bundle = bundle_path.read_bytes()

    root_key = _key()
    root_name = _name("local-root")
    root = _sign_ca(root_key, root_key, root_name, root_name, path_length=None)

    intermediate_key = _key()
    intermediate_name = _name("revoked-intermediate")
    intermediate = _sign_ca(
        intermediate_key,
        root_key,
        intermediate_name,
        root_name,
        path_length=0,
    )
    crl = _revoke(root, root_key, intermediate.serial_number)
    assert any(
        revoked.serial_number == intermediate.serial_number
        for revoked in crl
    )

    leaf_key = _key()
    leaf = _sign_leaf(
        leaf_key,
        intermediate_key,
        intermediate_name,
        ipaddress.IPv4Address("127.0.0.1"),
    )
    trusted_dir = tmp_path / "trusted"
    trusted_dir.mkdir()
    trusted_cert, trusted_key = _write_server_material(
        trusted_dir, leaf, leaf_key, intermediate
    )

    unknown_key = _key()
    unknown_name = _name("unknown-root")
    unknown_root = _sign_ca(unknown_key, unknown_key, unknown_name, unknown_name, path_length=None)
    unknown_leaf_key = _key()
    unknown_leaf = _sign_leaf(
        unknown_leaf_key,
        unknown_key,
        unknown_name,
        ipaddress.IPv4Address("127.0.0.1"),
    )
    unknown_dir = tmp_path / "unknown"
    unknown_dir.mkdir()
    unknown_cert, unknown_key_path = _write_server_material(
        unknown_dir, unknown_leaf, unknown_leaf_key, unknown_root
    )

    captured: dict[str, bytes | int] = {}
    ready = threading.Event()
    server = threading.Thread(
        target=_serve,
        args=(trusted_cert, trusted_key, captured, ready),
        daemon=True,
    )
    server.start()
    assert ready.wait(5)
    port = int(captured["port"])

    unknown_captured: dict[str, bytes | int] = {}
    unknown_ready = threading.Event()
    unknown_server = threading.Thread(
        target=_serve,
        args=(unknown_cert, unknown_key_path, unknown_captured, unknown_ready),
        daemon=True,
    )
    unknown_server.start()
    assert unknown_ready.wait(5)

    # index.py never sets these. When they are unset, httpx loads certifi.
    os.environ.pop("SSL_CERT_FILE", None)
    os.environ.pop("SSL_CERT_DIR", None)
    os.environ["OPENAI_API_KEY"] = PLACEHOLDER_API_KEY
    os.environ["OPENAI_BASE_URL"] = f"https://127.0.0.1:{port}/v1/"
    sys.path.insert(0, str(EXAMPLE_ROOT))

    try:
        # The appended root is loaded by the same PEM walk as every other
        # certificate already in the shipped bundle, including emSign G3.
        bundle_path.write_bytes(original_bundle + b"\n" + _pem_cert(root))
        import importlib

        sys.modules.pop("api.index", None)
        sys.modules.pop("api", None)
        index = importlib.import_module("api.index")
        context = _app_ssl_context(index.client)
        anchors = _trust_anchors(context)
        assert any(anchor.subject == root.subject for anchor in anchors)
        assert context.verify_mode == ssl.CERT_REQUIRED
        assert context.check_hostname is True
        assert not (int(context.verify_flags) & ssl.VERIFY_CRL_CHECK_LEAF)
        assert not (int(context.verify_flags) & ssl.VERIFY_CRL_CHECK_CHAIN)

        yielded = list(index.stream_text([{"role": "user", "content": "ping"}]))
        assert yielded
        request = captured["request"]
        assert isinstance(request, bytes)
        assert _header_value(request, "authorization") == f"Bearer {PLACEHOLDER_API_KEY}"
        assert b"/v1/chat/completions" in request.split(b"\r\n", 1)[0]

        # Same trust store, certificate that does not chain to it.
        import httpx

        with pytest.raises(httpx.ConnectError):
            index.client._client.post(f"https://127.0.0.1:{unknown_captured['port']}/v1/chat/completions")

        emsign = [
            anchor
            for anchor in anchors
            if anchor.fingerprint(hashes.SHA256()) == EMSIGN_ECC_ROOT_G3_SHA256
        ]
        assert emsign == []
    finally:
        bundle_path.write_bytes(original_bundle)
        server.join(timeout=5)
        unknown_server.join(timeout=1)
