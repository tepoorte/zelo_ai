import type { Product } from "../../swissdata/products.js";

export function formatOptionQuestion(product: Product): string {
  const options = Array.isArray(product.availableOptions) ? product.availableOptions : [];

  if (!options.length) {
    return `J’ai trouvé “${product.name}”, mais je n’ai pas réussi à lire ses options.`;
  }

  const lines: string[] = [];
  lines.push(`J’ai trouvé « ${product.name} ».`);
  lines.push("Il y a plusieurs options disponibles :");
  lines.push("");

  options.forEach((option, index) => {
    const label = option?.name || `Option ${index + 1}`;
    const extra = option?.shortDescription || option?.description || "";
    lines.push(`${index + 1}. ${label}${extra ? ` — ${extra}` : ""}`);
  });

  lines.push(`${options.length + 1}. Aucune`);
  lines.push("");
  lines.push("Quelles options veux-tu sélectionner ?");
  lines.push("Écris « aucune » si tu ne veux sélectionner aucune option.");

  return lines.join("\n");
}

export function normalizeLooseText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveOptionsFromText(
  userText: string,
  availableOptions: Array<{ id: string; name: string; shortDescription?: string; description?: string }>
) {
  const text = normalizeLooseText(userText);
  const numericChoice = Number(text);

  if (Number.isInteger(numericChoice) && numericChoice >= 1) {
    const option = availableOptions[numericChoice - 1];
    return option ? [{ id: option.id, name: option.name }] : [];
  }

  const selected: Array<{ id: string; name: string }> = [];

  for (const option of availableOptions) {
    const haystacks = [
      option.name,
      option.shortDescription,
      option.description,
    ]
      .filter(Boolean)
      .map((value) => normalizeLooseText(String(value)));

    const matched = haystacks.some((haystack) =>
      haystack && (text.includes(haystack) || haystack.includes(text))
    );

    if (matched) {
      selected.push({ id: option.id, name: option.name });
      continue;
    }

    const optionWords = normalizeLooseText(option.name).split(" ").filter(Boolean);
    const hasWordOverlap = optionWords.some((word) => word.length > 2 && text.includes(word));
    if (hasWordOverlap) {
      selected.push({ id: option.id, name: option.name });
    }
  }

  const seen = new Set<string>();
  return selected.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

export function userChoseNoOptions(
  userText: string,
  availableOptions: Array<{ id: string; name: string; shortDescription?: string; description?: string }> = []
): boolean {
  const text = normalizeLooseText(userText);
  const numericChoice = Number(text);

  return (
    text === "aucune" ||
    (Number.isInteger(numericChoice) && numericChoice === availableOptions.length + 1)
  );
}
