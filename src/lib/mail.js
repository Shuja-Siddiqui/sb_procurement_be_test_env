const nodemailer = require("nodemailer");

let transporter = null;

const isSmtpConfigured = () =>
  Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
  );

const getTransporter = () => {
  if (transporter) return transporter;
  if (!isSmtpConfigured()) return null;

  const port = Number(process.env.SMTP_PORT) || 587;
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
    port === 465;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
};

const getFromAddress = () =>
  process.env.SMTP_FROM ||
  process.env.SMTP_USER ||
  "Site Tracking <noreply@sitetracking.local>";

const sendPasswordResetOtpEmail = async ({ to, name, code, expiresMinutes }) => {
  const transport = getTransporter();
  if (!transport) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const displayName = String(name || "User").trim() || "User";
  const subject = "Site Tracking password reset verification code";
  const text = [
    `Hello ${displayName},`,
    "",
    `Your Site Tracking password reset code is: ${code}`,
    "",
    `This code expires in ${expiresMinutes} minutes.`,
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: system-ui, sans-serif; color: #131b2e; max-width: 480px;">
      <p>Hello ${displayName},</p>
      <p>Use this code to reset your Site Tracking password:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.25em; color: #4648d4;">${code}</p>
      <p style="color: #464554; font-size: 14px;">This code expires in ${expiresMinutes} minutes.</p>
      <p style="color: #767586; font-size: 12px;">If you did not request this, you can ignore this email.</p>
    </div>
  `;

  await transport.sendMail({
    from: getFromAddress(),
    to,
    subject,
    text,
    html,
  });

  return { sent: true };
};

module.exports = {
  isSmtpConfigured,
  sendPasswordResetOtpEmail,
};
