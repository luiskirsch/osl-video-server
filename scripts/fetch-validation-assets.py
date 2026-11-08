"""Refresh public ANS schemas and ICP-Brasil CA certificates (no patient data)."""
import hashlib
import io
import json
import ssl
from pathlib import Path
import urllib.request
import zipfile
import certifi
from cryptography import x509
from cryptography.hazmat.primitives import serialization

ROOT = Path(__file__).resolve().parents[1] / "security-assets"
SOURCES = {
    "tiss": "https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/PadroTISSComunicao_202511.zip",
    "icp": "https://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip",
}


def main():
    manifest = {}
    context = ssl.create_default_context(cafile=certifi.where())
    # ITI's server omits its Let's Encrypt intermediate. Supply that intermediate,
    # but still require a complete chain to a root from certifi (never partial trust).
    context.verify_flags &= ~ssl.VERIFY_X509_PARTIAL_CHAIN
    for issuer_url in ("http://ye1.i.lencr.org/", "http://ye.i.lencr.org/"):
        issuer_data = urllib.request.urlopen(issuer_url, timeout=20).read(100_000)
        issuer = x509.load_der_x509_certificate(issuer_data)
        if issuer.subject == issuer.issuer:
            raise ValueError("UNEXPECTED_TLS_ROOT")
        context.load_verify_locations(cadata=issuer.public_bytes(serialization.Encoding.PEM).decode())
    for kind, url in SOURCES.items():
        with urllib.request.urlopen(url, timeout=60, context=context) as response:
            data = response.read(20_000_001)
        if len(data) > 20_000_000:
            raise ValueError("PUBLIC_BUNDLE_TOO_LARGE")
        archive = zipfile.ZipFile(io.BytesIO(data))
        dest = ROOT / kind
        dest.mkdir(parents=True, exist_ok=True)
        files = {}
        for member in archive.infolist():
            name = Path(member.filename).name
            if kind == "tiss" and not ("040300/" in member.filename and name.endswith((".xsd", ".wsdl"))):
                continue
            if kind == "icp" and not name.lower().endswith((".crt", ".cer")):
                continue
            if member.file_size > 5_000_000:
                raise ValueError("PUBLIC_FILE_TOO_LARGE")
            content = archive.read(member)
            (dest / name).write_bytes(content)
            files[name] = hashlib.sha256(content).hexdigest()
        if not files:
            raise ValueError("EMPTY_PUBLIC_BUNDLE")
        manifest[kind] = {"source": url, "sha256": hashlib.sha256(data).hexdigest(), "files": files}
        print(kind, len(files), "public files")
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
