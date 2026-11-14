const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why `email` can't be used, or null when it can. */
export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return "Enter your email.";
  if (trimmed.length > 254) return "That email is too long.";
  if (!EMAIL.test(trimmed)) return "That doesn't look like an email.";
  return null;
}
