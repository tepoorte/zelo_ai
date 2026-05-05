export const FOOD_CATEGORY_IDS = [
  "5dcfc1616f4a93324a0a2b1a",
  "5dcfddcb6f4a93324a0a2b1e",
  "5dcfde1f6f4a93324a0a2b1f",
  "5dcfde5d6f4a93324a0a2b20",
  "5dcfdec16f4a93324a0a2b21",
  "5dcfdf0e6f4a93324a0a2b22",
  "5dcfdf4c6f4a93324a0a2b23",
] as const;

export const PREPARED_CATEGORY_IDS = [
  "5f00d2cda5761c0007833362",
] as const;

export const EXCLUDED_CATEGORY_IDS = [
  "5dcfdf736f4a93324a0a2b24",
  "5dcfdf906f4a93324a0a2b25",
  "5dea5c3d7e6ac104dac9fde2",
  "5f718b85d9f31d00075c9899",
] as const;

export const CATEGORY_NAME_BY_ID: Record<string, string> = {
  "5dcfc1616f4a93324a0a2b1a": "lait fromages oeufs",
  "5dcfddcb6f4a93324a0a2b1e": "boulangerie patisseries",
  "5dcfde1f6f4a93324a0a2b1f": "fruits legumes",
  "5dcfde5d6f4a93324a0a2b20": "farines cereales noix",
  "5dcfdec16f4a93324a0a2b21": "feculents",
  "5dcfdf0e6f4a93324a0a2b22": "viande poisson",
  "5dcfdf4c6f4a93324a0a2b23": "epices huiles sauces",
  "5f00d2cda5761c0007833362": "menus pizzas",
  "5dcfdf736f4a93324a0a2b24": "cosmetiques hygiene",
  "5dcfdf906f4a93324a0a2b25": "menage accessoires",
  "5dea5c3d7e6ac104dac9fde2": "boissons",
  "5f718b85d9f31d00075c9899": "contenants",
};

export const CANONICAL_FOOD_CATEGORY_NAMES = [
  "lait fromages oeufs",
  "boulangerie patisseries",
  "fruits legumes",
  "farines cereales noix",
  "feculents",
  "viande poisson",
  "epices huiles sauces",
] as const;
