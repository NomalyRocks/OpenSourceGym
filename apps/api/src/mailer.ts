import nodemailer from "nodemailer";
import { env } from "./env.js";

const transport = env.smtp.host
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth:
        env.smtp.user && env.smtp.pass
          ? { user: env.smtp.user, pass: env.smtp.pass }
          : undefined,
    })
  : null;

export async function sendMail(options: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  if (!transport) {
    if (env.nodeEnv === "production") {
      throw new Error("SMTP is not configured (SMTP_HOST missing)");
    }
    // In development, email goes to the console when SMTP is unavailable
    console.log(
      `[mail:dev] to=${options.to} subject="${options.subject}"\n${options.text}`,
    );
    return;
  }
  await transport.sendMail({ from: env.smtp.from, ...options });
}
