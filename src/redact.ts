// Redaction before anything leaves the machine (the digest summary sent to `claude -p`, exports).
// Prompts and results are local data; they can contain keys, tokens and passwords people pasted.

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[aws key]"],
  [/\b(?:sk|pk|rk)-(?:ant-|live-|test-|proj-)?[A-Za-z0-9_-]{16,}\b/g, "[api key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[github token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[slack token]"],
  [/\bam_[A-Za-z0-9]{24,}\b/g, "[api key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [token]"],
  // credentials inside URLs: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[password]@"],
  // key = value / key: value, for names that are secrets
  [/\b((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1[redacted]"],
];

/** Pure. Replaces secrets with labels; everything else is left as it was. */
export function redact(text: string): string {
  let out = text;
  for (const [re, by] of RULES) out = out.replace(re, by);
  return out;
}
