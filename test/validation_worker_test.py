"""Synthetic certificates only. These tests are NOT evidence of ICP accreditation."""
import asyncio
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
import validation_worker as worker
from cryptography import x509
from cryptography.x509.oid import NameOID, ObjectIdentifier
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from asn1crypto import core, x509 as asn1x509, crl as asn1crl
from pyhanko.pdf_utils.writer import PdfFileWriter, PageObject
from pyhanko.pdf_utils.generic import StreamObject

CPF = "12345678901"


def fixture():
    now = datetime.now(timezone.utc)
    root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic TEST CA - not ICP")])
    root = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name).public_key(root_key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=True, path_length=1), True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), True)
            .sign(root_key, hashes.SHA256()))
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Profissional Sintetico:" + CPF)])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(root_name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(hours=1)).not_valid_after(now+timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), True)
            .add_extension(x509.SubjectAlternativeName([x509.OtherName(ObjectIdentifier("2.16.76.1.3.1"), core.UTF8String("01011990"+CPF).dump())]), False)
            .sign(root_key, hashes.SHA256()))
    pfx = pkcs12.serialize_key_and_certificates(b"synthetic", key, cert, [root], serialization.BestAvailableEncryption(b"test-password"))
    pdf = PdfFileWriter()
    stream = pdf.add_object(StreamObject(stream_data=b"BT /F1 12 Tf 50 50 Td (Synthetic test only) Tj ET"))
    pdf.insert_page(PageObject(contents=stream, media_box=[0, 0, 300, 300]))
    out = io.BytesIO(); pdf.write(out)
    crl = (x509.CertificateRevocationListBuilder().issuer_name(root_name)
           .last_update(now-timedelta(minutes=1)).next_update(now+timedelta(hours=1)))
    clean = crl.sign(root_key, hashes.SHA256())
    revoked_entry = (x509.RevokedCertificateBuilder().serial_number(cert.serial_number)
                     .revocation_date(now-timedelta(minutes=1)).build())
    revoked = crl.add_revoked_certificate(revoked_entry).sign(root_key, hashes.SHA256())
    return (out.getvalue(), pfx, asn1x509.Certificate.load(root.public_bytes(serialization.Encoding.DER)),
            asn1crl.CertificateList.load(clean.public_bytes(serialization.Encoding.DER)),
            asn1crl.CertificateList.load(revoked.public_bytes(serialization.Encoding.DER)))


class SignatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf, cls.pfx, cls.root, cls.clean_crl, cls.revoked_crl = fixture()
        cls.signed = worker.sign_pdf(cls.pdf, cls.pfx, "test-password")

    def test_real_pades_crypto_and_identity_with_synthetic_trust(self):
        result = asyncio.run(worker.validate_pdf(self.signed, CPF, trust=([self.root], []), online=False,
                                                expected_name="Profissional Sintético"))
        self.assertTrue(result["valid"])
        self.assertEqual(len(result["sha256"]), 64)
        self.assertIn(b"/ETSI.CAdES.detached", self.signed)

    def test_synthetic_ca_cannot_pass_production_icp_trust(self):
        with self.assertRaisesRegex(worker.ValidationFailure, "CADEIA_INVALIDA"):
            asyncio.run(worker.validate_pdf(self.signed, CPF))

    def test_unsigned_pdf_cannot_be_labelled_signed(self):
        with self.assertRaisesRegex(worker.ValidationFailure, "ASSINATURA_UNICA"):
            asyncio.run(worker.validate_pdf(self.pdf, CPF))

    def test_tampered_pdf_rejected(self):
        tampered = self.signed.replace(b"Synthetic test only", b"TamperedX test only")
        with self.assertRaises(worker.ValidationFailure):
            asyncio.run(worker.validate_pdf(tampered, CPF, trust=([self.root], []), online=False))

    def test_other_professional_certificate_rejected(self):
        with self.assertRaisesRegex(worker.ValidationFailure, "CPF_ASSINANTE_DIVERGENTE"):
            asyncio.run(worker.validate_pdf(self.signed, "98765432100", trust=([self.root], []), online=False))

    def test_name_mismatch_rejected(self):
        with self.assertRaisesRegex(worker.ValidationFailure, "NOME_ASSINANTE_DIVERGENTE"):
            asyncio.run(worker.validate_pdf(self.signed, CPF, expected_name="Outra Pessoa"))

    def test_missing_revocation_evidence_is_not_a_success(self):
        with self.assertRaisesRegex(worker.ValidationFailure, "REVOGACAO_NAO_CONFIRMADA"):
            asyncio.run(worker.validate_pdf(self.signed, CPF, trust=([self.root], []), online=True))

    def test_incorrect_password_rejected(self):
        with self.assertRaisesRegex(worker.ValidationFailure, "SENHA_INVALIDOS"):
            worker.sign_pdf(self.pdf, self.pfx, "incorrect")

    def test_complete_validation_requires_valid_revocation_evidence(self):
        result = asyncio.run(worker.validate_pdf(self.signed, CPF, trust=([self.root], [], [self.clean_crl]), online=True))
        self.assertTrue(result["revocationChecked"])

    def test_revoked_certificate_rejected(self):
        with self.assertRaises(worker.ValidationFailure):
            asyncio.run(worker.validate_pdf(self.signed, CPF, trust=([self.root], [], [self.revoked_crl]), online=True))


if __name__ == "__main__":
    unittest.main()
