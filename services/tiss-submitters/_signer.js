// Espaço Prelúdio — Assinatura digital XML-DSig pra lotes TISS.
//
// ANS exige que XML de lote TISS submetido via API (Fase 4 do nosso roadmap)
// seja assinado digitalmente com cert A1 ICP-Brasil do profissional. Cert
// vem no formato .pfx (PKCS#12), com senha.
//
// Implementação:
//   - node-forge: parse do .pfx → extrai private key + cert X.509
//   - xml-crypto: gera Signature element conforme W3C XML-DSig + canoniza
//     com C14N 1.0 (algoritmo padrão ANS)
//
// Algoritmos exigidos pela ANS:
//   - CanonicalizationMethod: http://www.w3.org/TR/2001/REC-xml-c14n-20010315
//   - SignatureMethod: http://www.w3.org/2001/04/xmldsig-more#rsa-sha256
//   - DigestMethod: http://www.w3.org/2001/04/xmlenc#sha256
//   - Transforms: enveloped + C14N
//
// IMPORTANTE: A1 cert é PESSOAL do profissional (CPF dele). Plataforma
// NUNCA persiste o cert plaintext — só recebe via API temporariamente,
// usa pra assinar, descarta. Em prod: cert vem cifrado no Firestore com
// chave derivada da senha do prof (similar ao prontuário E2EE).

const forge = require("node-forge");

let SignedXml;
try {
  // xml-crypto v6+: API SignedXml direto na raiz
  SignedXml = require("xml-crypto").SignedXml;
} catch (e) {
  // Fallback: lazy stub se lib não instalada (ex: build sem dev deps)
  SignedXml = null;
}

/**
 * Extrai private key + cert X.509 de um buffer .pfx (PKCS#12).
 *
 * @param {Buffer} pfxBuffer — conteúdo binário do arquivo .pfx
 * @param {string} password — senha do cert
 * @returns {{ privateKeyPem: string, certificatePem: string, subject: object }}
 */
function loadPfx(pfxBuffer, password) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString("binary")));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  // Extrai bag com private key
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag  = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0]
               || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
  if (!keyBag || !keyBag.key) throw new Error("PFX_SEM_PRIVATE_KEY");

  // Extrai cert
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = (certBags[forge.pki.oids.certBag] || [])[0];
  if (!certBag || !certBag.cert) throw new Error("PFX_SEM_CERT");

  return {
    privateKeyPem:  forge.pki.privateKeyToPem(keyBag.key),
    certificatePem: forge.pki.certificateToPem(certBag.cert),
    subject: certBag.cert.subject.attributes.reduce((acc, a) => {
      acc[a.shortName || a.name] = a.value;
      return acc;
    }, {})
  };
}

/**
 * Extrai o certificado em formato base64 DER (sem -----BEGIN/END----- e
 * sem quebras de linha) — formato exigido pelo elemento <X509Certificate>
 * dentro de <KeyInfo>.
 *
 * @param {string} certificatePem
 * @returns {string}
 */
function certPemToBase64(certificatePem) {
  return certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
}

/**
 * Assina um XML TISS com A1 cert. Adiciona o elemento <Signature> como
 * filho de <ans:mensagemTISS> (modo enveloped).
 *
 * @param {string} xml          — XML não assinado (saída de services/tiss.js buildLoteGuias)
 * @param {Buffer} pfxBuffer    — buffer do arquivo .pfx
 * @param {string} pfxPassword  — senha do .pfx
 * @returns {{ xmlAssinado: string, signatureValue: string, subject: object }}
 */
function signTissXml(xml, pfxBuffer, pfxPassword) {
  if (!SignedXml) throw new Error("XML_CRYPTO_NAO_INSTALADO");
  const { privateKeyPem, certificatePem, subject } = loadPfx(pfxBuffer, pfxPassword);
  const certBase64 = certPemToBase64(certificatePem);

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
  });
  sig.addReference({
    xpath: "/*",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
    ]
  });

  // KeyInfo customizado pra incluir X509Certificate
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`;

  sig.computeSignature(xml);
  return {
    xmlAssinado: sig.getSignedXml(),
    signatureValue: sig.getSignatureValue ? sig.getSignatureValue() : null,
    subject
  };
}

module.exports = { loadPfx, signTissXml, certPemToBase64 };
