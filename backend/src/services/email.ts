import { env } from "../config/env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

// Default provider until a real email service is wired in: prints emails to the console.
const consoleProvider: EmailProvider = {
  async send({ to, subject, text }) {
    console.log(`\n📧 Email to ${to}\nSubject: ${subject}\n\n${text}\n`);
  },
};

let provider: EmailProvider = consoleProvider;

/** Swap in a real provider (Resend, SES, SendGrid, ...) at startup. */
export function setEmailProvider(next: EmailProvider) {
  provider = next;
}

export function sendEmail(message: EmailMessage) {
  return provider.send(message);
}

const codeEmail = (to: string, subject: string, intro: string, code: string) =>
  sendEmail({
    to,
    subject,
    text: `${intro}\n\nYour code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>${intro}</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  });

export const sendVerificationEmail = (to: string, code: string) =>
  codeEmail(to, `Verify your ${env.appName} email`, `Welcome to ${env.appName}! Confirm your email address.`, code);

export const sendLoginCodeEmail = (to: string, code: string) =>
  codeEmail(to, `Your ${env.appName} sign-in code`, `Use this code to sign in to ${env.appName}.`, code);

export const sendTwoFactorCodeEmail = (to: string, code: string) =>
  codeEmail(to, `Your ${env.appName} verification code`, `Use this code to finish signing in to ${env.appName}.`, code);
