import crypto from 'node:crypto';

export function canonicalizeUrl(value) {
  const u = new URL(value);
  u.hash = '';
  ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(k => u.searchParams.delete(k));
  if (u.hostname === 'i.pinimg.com') u.pathname = u.pathname.replace(/^\/(236x|474x|564x|736x)\//, '/originals/');
  u.searchParams.sort();
  return u.toString();
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
