import nodemailer from "nodemailer";

import { env } from "../config/env.js";
import {
  createPasswordChangedEmailTemplate,
  createPasswordResetEmailTemplate,
  createVerificationEmailTemplate,
} from "../utils/email-template.util.js";

const transporter = nodemailer.createTransport({
  host: env.EMAIL_HOST,
  port: env.EMAIL_PORT,
  secure: false,
  auth: {
    user: env.EMAIL_USER,
    pass: env.EMAIL_PASSWORD,
  },
});

export const verifyEmailConnection = async (): Promise<void> => {
  await transporter.verify();

  console.log("✅ Gmail SMTP connection verified");
};

export const sendEmail = async (
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<void> => {
  await transporter.sendMail({
    from: env.EMAIL_USER,
    to,
    subject,
    text,
    html,
  });
};

export const sendVerificationEmail = async (
  email: string,
  verificationUrl: string,
): Promise<void> => {
  const { subject, text, html } =
    createVerificationEmailTemplate(verificationUrl);

  await sendEmail(email, subject, text, html);
};

export const sendPasswordResetEmail = async (
  email: string,
  resetUrl: string,
  expiresInMinutes: number,
): Promise<void> => {
  const { subject, text, html } =
    createPasswordResetEmailTemplate(
      resetUrl,
      expiresInMinutes,
    );

  await sendEmail(email, subject, text, html);
};

export const sendPasswordChangedEmail = async (
  email: string,
): Promise<void> => {
  const { subject, text, html } =
    createPasswordChangedEmailTemplate();

  await sendEmail(email, subject, text, html);
};
