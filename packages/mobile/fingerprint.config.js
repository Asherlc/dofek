/** @type {import("expo/fingerprint").Config} */
module.exports = {
  extraSources: [
    { type: "dir", filePath: "targets", reasons: ["watchAppSources"] },
    { type: "file", filePath: "certs/certificate.pem", reasons: ["updateSigningCertificate"] },
    { type: "file", filePath: "plugins/Sentry.podspec.json", reasons: ["nativeSentryDependency"] },
    { type: "dir", filePath: "../../patches", reasons: ["workspaceDependencyPatches"] },
  ],
};
