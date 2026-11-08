"""Local cryptographic PDF signing/validation and ANS XSD validation.

One bounded JSON request on stdin; only a bounded result on stdout. Private keys,
passwords and documents never leave this process or go to a third-party service.
"""
import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import io
import ipaddress
import json
import logging
from pathlib import Path
import re
import sys
import unicodedata

logging.disable(logging.CRITICAL)
ASSETS = Path(__file__).resolve().parents[1] / "security-assets"


class ValidationFailure(Exception):
    pass


def decode(value, maximum):
    try:
        data = base64.b64decode(value, validate=True)
    except Exception:
        raise ValidationFailure("BASE64_INVALIDO")
    if not data or len(data) > maximum:
        raise ValidationFailure("ARQUIVO_TAMANHO_INVALIDO")
    return data


def certificates():
    from asn1crypto import pem, x509
    roots, intermediates = [], []
    for path in (ASSETS / "icp").glob("*"):
        if path.suffix.lower() not in (".crt", ".cer"):
            continue
        data = path.read_bytes()
        if pem.detect(data):
            _, _, data = pem.unarmor(data)
        cert = x509.Certificate.load(data)
        # Never treat every certificate in the official bundle as a trust anchor.
        # v3 was revoked; SSL/code-signing roots are not document-signing roots.
        if cert.subject == cert.issuer:
            cn = cert.subject.native.get("common_name", "")
            if re.search(r"v(?:4|5|6|7|12|13)$", cn, re.I):
                roots.append(cert)
        else:
            intermediates.append(cert)
    if not roots:
        raise ValidationFailure("CADEIA_ICP_INDISPONIVEL")
    return roots, intermediates


def certificate_cpf(cert):
    from asn1crypto import core
    for name in cert.subject_alt_name_value or []:
        if name.name != "other_name":
            continue
        item = name.chosen
        if item["type_id"].dotted == "2.16.76.1.3.1":
            # DOC-ICP-04: date of birth (8 digits), CPF (11), remaining fields.
            value = item["value"].parsed.native
            if isinstance(value, bytes):
                value = value.decode("ascii", errors="strict")
            if isinstance(value, str) and re.match(r"^\d{19}", value):
                return value[8:19]
    raise ValidationFailure("CERTIFICADO_ECPF_OBRIGATORIO")


async def validate_pdf(data, cpf, *, trust=None, online=True, expected_name=None):
    import aiohttp
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import async_validate_pdf_signature
    from pyhanko.sign.validation.status import SignatureCoverageLevel
    from pyhanko_certvalidator import ValidationContext
    from pyhanko_certvalidator.policy_decl import CertRevTrustPolicy, RevocationCheckingPolicy, RevocationCheckingRule
    from pyhanko_certvalidator.fetchers.aiohttp_fetchers import AIOHttpFetcherBackend
    from pyhanko_certvalidator.fetchers.api import FetchLimits

    if not data.startswith(b"%PDF-"):
        raise ValidationFailure("PDF_INVALIDO")
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    signatures = reader.embedded_regular_signatures
    if len(signatures) != 1:
        raise ValidationFailure("PDF_ASSINATURA_UNICA_OBRIGATORIA")
    signature = signatures[0]
    if certificate_cpf(signature.signer_cert) != cpf:
        raise ValidationFailure("CPF_ASSINANTE_DIVERGENTE")
    if expected_name:
        def normalized(name):
            return re.sub(r"[^A-Z ]", "", unicodedata.normalize("NFKD", name.upper())).split()
        certificate_name = signature.signer_cert.subject.native.get("common_name", "").split(":")[0]
        if normalized(certificate_name) != normalized(expected_name):
            raise ValidationFailure("NOME_ASSINANTE_DIVERGENTE")
    roots, intermediates = (trust or certificates())[:2]
    crls = trust[2] if trust and len(trust) > 2 else None
    offline = ValidationContext(trust_roots=roots, other_certs=intermediates,
                                allow_fetching=False, revocation_mode="soft-fail", crls=crls)
    preliminary = await async_validate_pdf_signature(signature, offline)
    if not (preliminary.intact and preliminary.valid and preliminary.trusted):
        raise ValidationFailure("ASSINATURA_OU_CADEIA_INVALIDA")
    if preliminary.coverage != SignatureCoverageLevel.ENTIRE_FILE or not preliminary.docmdp_ok:
        raise ValidationFailure("PDF_ALTERADO_OU_COBERTURA_INCOMPLETA")

    class PublicConnector(aiohttp.TCPConnector):
        async def _resolve_host(self, host, port, *args, **kwargs):
            if port not in (80, 443):
                raise OSError("REVOGACAO_PORTA_NAO_PERMITIDA")
            result = await super()._resolve_host(host, port, *args, **kwargs)
            if any(not ipaddress.ip_address(r["host"]).is_global or ipaddress.ip_address(r["host"]).is_multicast for r in result):
                raise OSError("REVOGACAO_ENDERECO_NAO_PERMITIDO")
            return result

    class BoundedResponse(aiohttp.ClientResponse):
        async def read(self):
            if self._body is None:
                chunks, total = [], 0
                async for chunk in self.content.iter_chunked(64_000):
                    total += len(chunk)
                    if total > 5_000_000:
                        self.close()
                        raise OSError("REVOGACAO_RESPOSTA_EXCESSIVA")
                    chunks.append(chunk)
                self._body = b"".join(chunks)
            return self._body

    if online:
        # Fetch only after verifying the certificate's chain offline. Block private
        # networks, including redirect targets, IP literals and DNS rebinding.
        async with aiohttp.ClientSession(connector=PublicConnector(), response_class=BoundedResponse, trust_env=False,
                                         timeout=aiohttp.ClientTimeout(total=25)) as session:
            backend = AIOHttpFetcherBackend(session=session, per_request_timeout=8,
                      limits=FetchLimits(max_requests=20, max_cert_requests=5))
            context = ValidationContext(trust_roots=roots, other_certs=intermediates,
                        allow_fetching=True, crls=crls, fetcher_backend=backend,
                        revinfo_policy=CertRevTrustPolicy(RevocationCheckingPolicy(
                          RevocationCheckingRule.CRL_OR_OCSP_REQUIRED,
                          RevocationCheckingRule.CRL_OR_OCSP_REQUIRED)))
            final = await async_validate_pdf_signature(signature, context)
            if not final.bottom_line:
                raise ValidationFailure("REVOGACAO_NAO_CONFIRMADA")
    return {"valid": True, "standard": "ICP-Brasil", "engine": "pyHanko",
            "sha256": hashlib.sha256(data).hexdigest(),
            "certificateSha256": hashlib.sha256(signature.signer_cert.dump()).hexdigest(),
            "signerName": signature.signer_cert.subject.native.get("common_name", "").split(":")[0],
            "validatedAt": datetime.now(timezone.utc).isoformat(), "revocationChecked": online}


def sign_pdf(data, pfx, password):
    from cryptography.hazmat.primitives.serialization import pkcs12, Encoding, PrivateFormat, NoEncryption
    from asn1crypto import keys, x509
    from pyhanko.sign import signers
    from pyhanko.sign.fields import SigSeedSubFilter, MDPPerm, SigFieldSpec
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko_certvalidator.registry import SimpleCertificateStore
    try:
        key, cert, chain = pkcs12.load_key_and_certificates(pfx, password.encode("utf-8"))
    except Exception:
        raise ValidationFailure("CERTIFICADO_OU_SENHA_INVALIDOS")
    if key is None or cert is None:
        raise ValidationFailure("CERTIFICADO_SEM_CHAVE")
    store = SimpleCertificateStore()
    store.register_multiple(x509.Certificate.load(c.public_bytes(Encoding.DER)) for c in chain or [])
    signer = signers.SimpleSigner(
        signing_cert=x509.Certificate.load(cert.public_bytes(Encoding.DER)),
        signing_key=keys.PrivateKeyInfo.load(key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())),
        cert_registry=store, embed_roots=False)
    metadata = signers.PdfSignatureMetadata(field_name="PreludioSignature", md_algorithm="sha256",
        subfilter=SigSeedSubFilter.PADES, certify=True, docmdp_permissions=MDPPerm.NO_CHANGES)
    output = signers.sign_pdf(IncrementalPdfFileWriter(io.BytesIO(data)), metadata,
        signer=signer, new_field_spec=SigFieldSpec(sig_field_name="PreludioSignature"))
    return output.getvalue()


def validate_tiss(xml):
    from lxml import etree
    if not isinstance(xml, str) or not 0 < len(xml) <= 5_000_000:
        raise ValidationFailure("XML_TAMANHO_INVALIDO")
    if "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
        raise ValidationFailure("XML_ENTIDADES_PROIBIDAS")
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)
    doc = etree.fromstring(xml.encode("utf-8"), parser)
    schema = etree.XMLSchema(etree.parse(str(ASSETS / "tiss" / "tissV4_03_00.xsd"), parser))
    if not schema.validate(doc):
        # Do not return XML values (patient data) in diagnostics.
        return {"valid": False, "error": "TISS_XSD_INVALIDO", "issues": [
            {"line": item.line, "type": item.type_name, "path": item.path}
            for item in list(schema.error_log)[:10]]}
    return {"valid": True, "version": "4.03.00", "schema": "ANS-202511",
            "sha256": hashlib.sha256(xml.encode()).hexdigest()}


def main():
    request = json.loads(sys.stdin.buffer.read(12_000_001))
    operation = request.get("operation")
    if operation == "tiss":
        return validate_tiss(request.get("xml"))
    if operation not in ("sign", "verify"):
        raise ValidationFailure("OPERACAO_INVALIDA")
    cpf = str(request.get("cpf", ""))
    if not re.fullmatch(r"\d{11}", cpf):
        raise ValidationFailure("CPF_PROFISSIONAL_OBRIGATORIO")
    data = decode(request.get("pdfBase64", ""), 5_000_000)
    if operation == "sign":
        data = sign_pdf(data, decode(request.get("certPfxBase64", ""), 100_000), request.get("certPassword", ""))
    verification = asyncio.run(validate_pdf(data, cpf, expected_name=request.get("expectedName")))
    return {"verification": verification, **({"pdfBase64": base64.b64encode(data).decode()} if operation == "sign" else {})}


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, **main()}))
    except ValidationFailure as error:
        print(json.dumps({"ok": False, "error": str(error)}))
    except Exception:
        # Never echo parsing/PKCS#12 exceptions, payloads, certificate CPF or secrets.
        print(json.dumps({"ok": False, "error": "VALIDACAO_NAO_CONCLUIDA"}))
