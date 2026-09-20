function canonicalizeUrl(value) {
  const u = new URL(value);
  u.hash = "";
  ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach((k) => u.searchParams.delete(k));
  u.searchParams.sort();
  return u.toString();
}

module.exports = { canonicalizeUrl };
