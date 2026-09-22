/**
 * Normalize a phone number delivered by Meta/WhatsApp to its international
 * digit-only form (the `wa_id` representation).
 *
 * This function deliberately does not guess a country code for national
 * numbers: the webhook already supplies an international identifier.
 */
export function normalizeMetaWhatsAppPhone(input: string): string {
  const withoutJid = String(input || "").split("@")[0] || "";
  let digits = withoutJid.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : "";
}

/**
 * Canonicalize values stored by Swissdata for comparison with a Meta wa_id.
 * Swiss national notation is accepted only with its trunk prefix (`0`). Bare
 * values such as `76…` are rejected because their country is ambiguous.
 */
export function canonicalizeSwissdataPhone(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const explicitlyInternational = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (explicitlyInternational) {
    return /^[1-9]\d{7,14}$/.test(digits) ? digits : "";
  }
  if (/^41\d{9}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return `41${digits.slice(1)}`;
  return "";
}

export function swissdataPhoneLookupVariants(metaPhone: string): string[] {
  const canonical = normalizeMetaWhatsAppPhone(metaPhone);
  if (!canonical) return [];

  const variants = new Set<string>([`+${canonical}`, canonical, `00${canonical}`]);
  if (/^41\d{9}$/.test(canonical)) {
    const local = `0${canonical.slice(2)}`;
    variants.add(local);
    const localGroups = [local.slice(0, 3), local.slice(3, 6), local.slice(6, 8), local.slice(8)];
    const internationalGroups = [
      canonical.slice(0, 2),
      canonical.slice(2, 4),
      canonical.slice(4, 7),
      canonical.slice(7, 9),
      canonical.slice(9),
    ];
    for (const separator of [" ", "-", ".", "/"]) {
      variants.add(localGroups.join(separator));
      variants.add(`+${internationalGroups.join(separator)}`);
      variants.add(`00${internationalGroups.join(separator)}`);
    }
  }
  return [...variants];
}

/** Build a server-controlled, anchored Swissdata search regexp. */
export function swissdataPhoneSearchPattern(metaPhone: string): string {
  const canonical = normalizeMetaWhatsAppPhone(metaPhone);
  if (!canonical) return "";
  const separator = "[\\s()./-]*";
  const separated = (digits: string) => digits.split("").join(separator);
  const alternatives = [
    separated(canonical),
    `\\+${separator}${separated(canonical)}`,
    `0${separator}0${separator}${separated(canonical)}`,
  ];
  if (/^41\d{9}$/.test(canonical)) {
    alternatives.push(separated(`0${canonical.slice(2)}`));
  }
  return `$^\\s*(?:${alternatives.join("|")})\\s*$`;
}

export function isSameWhatsAppPhone(left: string, metaPhone: string): boolean {
  const expected = normalizeMetaWhatsAppPhone(metaPhone);
  return Boolean(expected && canonicalizeSwissdataPhone(left) === expected);
}
