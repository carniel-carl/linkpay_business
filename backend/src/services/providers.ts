// Wires the email provider and file storage the environment names (EMAIL_PROVIDER, STORAGE_PROVIDER; read and
// checked in src/config/env.ts), when this module is imported. index.ts imports it rather than wiring them in its
// own body, so that whatever loads index.ts's imports without starting the server gets the same setup: preflight
// does, and the scripts that send email or touch files import it too (migrate-kyb-documents.ts). The test suites
// set their own providers instead (tests/setup.ts pins console email and local files); tests/providers.test.ts
// loads this one in subprocesses, against stand-ins.
import { env } from "../config/env";
import { emailProviderName, setEmailProvider } from "./email";
import { createResendProvider } from "./resend";
import { createS3Storage, fileStorageName, setFileStorage } from "./storage";

if (env.email.provider === "resend") {
  setEmailProvider(createResendProvider({ apiKey: env.email.apiKey, from: env.email.from, replyTo: env.email.replyTo }));
}
if (env.storage.provider === "s3") setFileStorage(createS3Storage(env.storage));

/** "Email: Resend, from …. Files: S3 bucket … .", for the startup log. */
export const providersMessage = () => `Email: ${emailProviderName() ?? "a provider set at startup"}. Files: ${fileStorageName() ?? "storage set at startup"}.`;
