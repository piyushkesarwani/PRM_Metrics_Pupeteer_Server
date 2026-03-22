const { execSync } = require('child_process');
const forge = require('node-forge');
const fs = require('fs');

// Generate RSA key pair
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();

cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + 1
);

const attrs = [{ name: 'commonName', value: 'dashboard-capture' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey, forge.md.sha256.create());

// Save private key
const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
fs.writeFileSync('server.key', privateKeyPem);
console.log('✅  server.key created');

// Save certificate
const certPem = forge.pki.certificateToPem(cert);
fs.writeFileSync('server.crt', certPem);
console.log('✅  server.crt created');

console.log('');
console.log('Next step: upload server.crt to your Salesforce Connected App');
