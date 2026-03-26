/*import fs from "node:fs";

const FILE = "./meal-feedback.json";

type MealFeedback = {
  [meal: string]: {
    bannedProducts: string[];
  };
};

function load(): MealFeedback {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(data: MealFeedback) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function banProductForMeal(meal: string, productName: string) {
  const db = load();

  const key = meal.toLowerCase().trim();

  if (!db[key]) {
    db[key] = { bannedProducts: [] };
  }

  if (!db[key].bannedProducts.includes(productName)) {
    db[key].bannedProducts.push(productName);
  }

  save(db);

  console.log("🧠 feedback saved:", key, "ban", productName);
}

export function getMealFeedback(meal: string) {
  const db = load();
  return db[meal.toLowerCase().trim()] || { bannedProducts: [] };
}
  */