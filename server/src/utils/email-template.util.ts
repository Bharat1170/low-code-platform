export interface VerificationEmailTemplate {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

export const createVerificationEmailTemplate = (
  verificationUrl: string,
): VerificationEmailTemplate => {
  const safeVerificationUrl = escapeHtml(verificationUrl);

  return {
    subject: "Verify your email address",
    text: [
      "Welcome to Low Code Platform.",
      "",
      "Please verify your email address by opening the link below:",
      "",
      verificationUrl,
      "",
      "This verification link will expire after 24 hours.",
      "",
      "If you did not create an account, you can safely ignore this email.",
    ].join("\n"),

    html: `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Verify your email address</title>
        </head>

        <body style="margin: 0; padding: 0; background-color: #f5f7fa; font-family: Arial, sans-serif;">
          <div style="max-width: 600px; margin: 40px auto; padding: 24px;">
            <div style="background-color: #ffffff; border-radius: 8px; padding: 32px;">
              <h1 style="margin-top: 0;">
                Verify your email address
              </h1>

              <p>
                Welcome to <strong>Low Code Platform</strong>.
              </p>

              <p>
                Please click the button below to verify your email address.
              </p>

              <p style="margin: 32px 0;">
                <a
                  href="${safeVerificationUrl}"
                  style="
                    display: inline-block;
                    padding: 12px 24px;
                    background-color: #2563eb;
                    color: #ffffff;
                    text-decoration: none;
                    border-radius: 6px;
                  "
                >
                  Verify Email
                </a>
              </p>

              <p>
                This verification link will expire after 24 hours.
              </p>

              <p>
                If the button does not work, copy and paste this URL into your
                browser:
              </p>

              <p style="word-break: break-all;">
                ${safeVerificationUrl}
              </p>

              <p>
                If you did not create an account, you can safely ignore this
                email.
              </p>
            </div>
          </div>
        </body>
      </html>
    `,
  };
};

const renderActionEmailHtml = (options: {
  title: string;
  paragraphs: string[];
  actionLabel?: string;
  actionUrl?: string;
}): string => {
  const paragraphs = options.paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");

  const action =
    options.actionLabel && options.actionUrl
      ? `
              <p style="margin: 32px 0;">
                <a
                  href="${escapeHtml(options.actionUrl)}"
                  style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px;"
                >
                  ${escapeHtml(options.actionLabel)}
                </a>
              </p>

              <p>If the button does not work, copy and paste this URL into your browser:</p>

              <p style="word-break: break-all;">${escapeHtml(options.actionUrl)}</p>`
      : "";

  return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta name="referrer" content="no-referrer" />
          <title>${escapeHtml(options.title)}</title>
        </head>

        <body style="margin: 0; padding: 0; background-color: #f5f7fa; font-family: Arial, sans-serif;">
          <div style="max-width: 600px; margin: 40px auto; padding: 24px;">
            <div style="background-color: #ffffff; border-radius: 8px; padding: 32px;">
              <h1 style="margin-top: 0;">${escapeHtml(options.title)}</h1>
              ${paragraphs}${action}
            </div>
          </div>
        </body>
      </html>
    `;
};

export const createPasswordResetEmailTemplate = (
  resetUrl: string,
  expiresInMinutes: number,
): VerificationEmailTemplate => {
  return {
    subject: "Reset your password",
    text: [
      "We received a request to reset your Low Code Platform password.",
      "",
      "Open the link below to choose a new password:",
      "",
      resetUrl,
      "",
      `This link will expire in ${expiresInMinutes} minutes and can be used only once.`,
      "",
      "If you did not request this, you can safely ignore this email. Your password has not been changed.",
    ].join("\n"),

    html: renderActionEmailHtml({
      title: "Reset your password",
      paragraphs: [
        "We received a request to reset your Low Code Platform password.",
        `This link will expire in ${expiresInMinutes} minutes and can be used only once.`,
        "If you did not request this, you can safely ignore this email. Your password has not been changed.",
      ],
      actionLabel: "Reset Password",
      actionUrl: resetUrl,
    }),
  };
};

export const createPasswordChangedEmailTemplate =
  (): VerificationEmailTemplate => {
    return {
      subject: "Your password was changed",
      text: [
        "The password for your Low Code Platform account was just changed, and you were signed out of all devices.",
        "",
        "If you did not do this, reset your password immediately and contact your organization administrator.",
      ].join("\n"),

      html: renderActionEmailHtml({
        title: "Your password was changed",
        paragraphs: [
          "The password for your Low Code Platform account was just changed, and you were signed out of all devices.",
          "If you did not do this, reset your password immediately and contact your organization administrator.",
        ],
      }),
    };
  };
