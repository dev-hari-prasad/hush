// worker/src/redaction.ts
// Redaction and OTP detection utilities

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const LONG_DIGITS_REGEX = /\b\d{8,}\b/g;
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const URL_QUERY_REGEX = /(\bhttps?:\/\/[^\s?#]+)\?[^\s#]+/gi;

const OTP_PATTERNS = [
  /\b\d{4,8}\b.*(?:verification|verify|code|otp|pin|token|one-time|auth)/i,
  /(?:verification|verify|code|otp|pin|token|one-time|auth).*\b\d{4,8}\b/i,
  /\b[A-Z0-9]{6,8}\b.*(?:login code|security code)/i,
  /(?:your\s+)?(?:verification|login|security|access)\s+code\s+is\s*:?\s*[A-Z0-9]{4,8}/i,
  /\b(?:G-\d{6}|[0-9]{6}\s+is\s+your)\b/i,
];

export function isVerificationCode(text: string): boolean {
  if (!text) return false;
  return OTP_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactText(text: string): string {
  if (!text) return '';

  return text
    // Strip query parameters from URLs first
    .replace(URL_QUERY_REGEX, '$1[URL_PARAMS]')
    // Redact emails
    .replace(EMAIL_REGEX, '[EMAIL]')
    // Redact long number sequences (8+ digits, like card numbers, bank accounts) BEFORE phone numbers
    .replace(LONG_DIGITS_REGEX, '[REDACTED_NUM]')
    // Redact phone numbers
    .replace(PHONE_REGEX, '[PHONE]');
}

export function sanitizePayload(title: string, body?: string, shouldRedact = true): { title: string; body: string; isOtp: boolean } {
  const rawCombined = `${title} ${body || ''}`;
  const isOtp = isVerificationCode(rawCombined);

  let cleanTitle = title.trim().slice(0, 200);
  let cleanBody = (body || '').trim().slice(0, 1000);

  if (shouldRedact) {
    cleanTitle = redactText(cleanTitle);
    cleanBody = redactText(cleanBody);
  }

  return {
    title: cleanTitle,
    body: cleanBody,
    isOtp,
  };
}
