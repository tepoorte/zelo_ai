import assert from "node:assert/strict";
import { extractAddItemsFromTextWithCatalog } from "../src/ai/services/add-items-extractor.service.js";
import { computeBasketQty } from "../src/ai/services/cart-quantity.service.js";
import { matchIngredientToProduct } from "../src/domain/matcher.js";
import { rankProductsByQuery, type Product } from "../src/swissdata/products.js";

const catalog: Product[] = [
  { id: "muesli-choco", name: "Muesli choco-amaranth Bio", size: "750g" },
  { id: "muesli-fruits", name: "Muesli aux fruits Bio", size: "700g" },
  { id: "pommes", name: "Pommes Bio ou VV", size: "1kg", priceType: "per-weight", refWeight: 1000, refWeightUnit: "g" },
  { id: "pdt-charlotte", name: "A. Pomme de terre Charlotte Bio", size: "1kg" },
  { id: "oeufs-nonbio", name: "A. Oeuf à la pièce (Non Bio)", size: "63g" },
  { id: "lard", name: "A. Lard de Begnins", size: "100g", priceType: "per-weight", refWeight: 100, refWeightUnit: "g" },
  { id: "crottins", name: "Crottins de chèvre par 2", size: "2 crottins" },
  { id: "sel", name: "Sel fin", size: "850g" },
  { id: "mozza", name: "Mozzarella de Buffle", size: "125g" },
  { id: "jus-pomme", name: "Jus de pomme Bio", size: "1 litre" },
  { id: "tofu", name: "Tofu nature", size: "240g" },
  { id: "pizza-marguerite", name: "Pizza Marguerite", size: "1 pièce" },
  { id: "farine-pizza", name: "Farine Pizza", size: "1kg" },
  { id: "panier-fruits-local-moyen", name: "Panier de FRUITS Bio ou VV 100% Local Moyen", size: "1 panier" },
  { id: "panier-budget-50", name: "Panier Budget 50", size: "1 panier" },
  { id: "filets-perche", name: "Filets de perche congelés", size: "500g" },
  { id: "pain-noix", name: "Pain aux noix", size: "1 pièce" },
  { id: "pain-balance", name: "Pain Balance", size: "1 pièce" },
  { id: "beurre-frais", name: "Beurre frais", size: "250g" },
  { id: "sorbet-fraise", name: "Sorbet Fraise", size: "1 pot" },
  { id: "yaourt-brebis-grand", name: "Yaourt de brebis nature (Grand pot)", size: "1 l" },
  { id: "yaourt-nature-grand", name: "Yaourt nature (Grand pot)", size: "1 l" },
  { id: "mini-pain-choc", name: "Mini-pain au choc", size: "1 pièce" },
  { id: "mini-sandwich", name: "Mini-Sandwich", size: "1 pièce" },
  { id: "pain-chocolat", name: "Pain au chocolat", size: "1 pièce" },
  { id: "choco-passion", name: "Choco-passion", size: "1 pièce" },
  { id: "cote-bette", name: "Côte de bette", size: "1 botte" },
  { id: "lait-sapalet", name: "A. Lait Bio pasteurisé (Sapalet)", size: "1 litre" },
  { id: "yogourt-stracciatella", name: "Yogourt Stracciatella", size: "grand pot" },
  { id: "filet-brochet", name: "Filet de brochet", size: "250g" },
  { id: "gruyere-alpage", name: "Gruyère d'alpage", size: "250g" },
  { id: "rhubarbe", name: "Rhubarbe", size: "500g" },
  { id: "pate-vaudois", name: "Pâté vaudois", size: "1 pièce" },
  { id: "pizza-margarita", name: "Pizza Margarita", size: "1 pièce" },
  { id: "chou-plume", name: "Chou plume", size: "1 botte" },
  { id: "sauce-lulu", name: "Sauce Lulu", size: "1 pot" },
  { id: "sauce-salvis", name: "Sauce Salvis", size: "1 pot" },
  { id: "pannette-mer-terre", name: "Pannette mer&terre", size: "1 pièce" },
  { id: "bircher-feuillantine", name: "Bircher de la Feuillantine", size: "1 pot" },
  { id: "pates-fraiches", name: "Pâtes fraîches", size: "500g" },
  { id: "barilla-fusilli", name: "A. Barilla Fusilli", size: "500g" },
  { id: "cafe-grain-decaf", name: "Café en grain décaféiné", size: "250g" },
  { id: "jus-orange", name: "Jus d'orange Bio", size: "1 litre" },
  { id: "oranges-sicile", name: "Oranges de Sicile", size: "2kg" },
  { id: "citron-bio", name: "A. Citron Bio", size: "1 pièce" },
  { id: "penne-complete", name: "Penne complète", size: "500g" },
  { id: "fricandeaux", name: "Fricandeaux", size: "1 pièce" },
  { id: "ballon-pavot", name: "Ballon au pavot", size: "1 pièce" },
];

function items(text: string) {
  return extractAddItemsFromTextWithCatalog(text, catalog).actions[0].items;
}

{
  const parsed = items("besoin de: Muesli choco-amaranth Bio, Pommes Bio ou VV 1 kg, A. Pomme de terre Charlotte Bio 1kg, A. 6 Oeufs à la pièce (Non Bio)");

  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((item) => item.productId), [
    "muesli-choco",
    "pommes",
    "pdt-charlotte",
    "oeufs-nonbio",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [1, 1, 1, 6]);
  assert.deepEqual(parsed.map((item) => item.unit), ["piece", "kg", "kg", "piece"]);
  assert.equal(parsed.some((item) => item.query === "VV"), false);
}

{
  const parsed = items("ajoute: Sel fin, Muesli aux fruits Bio, Jus de pomme Bio, Tofu nature");

  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((item) => item.productId), [
    "sel",
    "muesli-fruits",
    "jus-pomme",
    "tofu",
  ]);
}

{
  const parsed = items("ah me oui alors j aurais besoin un lard du begin, de pommes Bio, puis 1 kg de Crottins de chèvre par 2");

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => item.productId), [
    "lard",
    "pommes",
    "crottins",
  ]);
  assert.equal(parsed[0].query, "A. Lard de Begnins");
  assert.equal(parsed[0].qty, 1);
  assert.equal(parsed[1].query, "Pommes Bio ou VV");
  assert.equal(parsed[2].productId, "crottins");
  assert.equal(parsed[2].query, "Crottins de chèvre par 2");
  assert.equal(parsed[2].qty, 1);
  assert.equal(parsed[2].unit, "kg");
}

{
  const best = matchIngredientToProduct("sel de cuisine", [
    { id: "mozza", name: "Mozzarella de Buffle" },
    { id: "sel", name: "Sel fin" },
  ], { mozza: 50 });

  assert.equal(best?.id, "sel");
}

{
  const best = matchIngredientToProduct("lard du begin", [
    { id: "lard-fume", name: "Lard fumé" },
    { id: "lard-begnins", name: "A. Lard de Begnins" },
  ], { "lard-fume": 50 });

  assert.equal(best?.id, "lard-begnins");
}

{
  const best = matchIngredientToProduct("pommes Bio", [
    { id: "jus-pomme", name: "Jus de pomme Bio" },
    { id: "pommes", name: "Pommes Bio ou VV" },
  ], { "jus-pomme": 50 });

  assert.equal(best?.id, "pommes");
}

{
  const parsed = items("ajoute: 250 grammes de Sel fin, 2 kilos de Pommes Bio ou VV, 500 ml de Jus de pomme Bio");

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => item.productId), [
    "sel",
    "pommes",
    "jus-pomme",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [250, 2, 500]);
  assert.deepEqual(parsed.map((item) => item.unit), ["g", "kg", "ml"]);
}

{
  const parsed = items("cinquante lard du begnin, deux cents grammes de Sel fin, septante et un Muesli aux fruits Bio");

  assert.deepEqual(parsed.map((item) => item.productId), [
    "lard",
    "sel",
    "muesli-fruits",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [50, 200, 71]);
  assert.deepEqual(parsed.map((item) => item.unit), ["piece", "g", "piece"]);
}

{
  const parsed = items(
    "bonjur Andre j ai besion de Muesli choco-amarantx Bio et puis 2 Pomnes Bio ou VV et puis 1 kg de Crottins de chèvre par 2 stp merci"
  );

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => item.productId), [
    "muesli-choco",
    "pommes",
    "crottins",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [1, 2, 1]);
  assert.deepEqual(parsed.map((item) => item.unit), ["piece", "piece", "kg"]);
}

{
  const parsed = items(
    "quand tu peux mets dans mon panier Sel fim ensuite Muesli aux fruiys Bio puis Jus de pomme Bio merci"
  );

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => item.productId), [
    "sel",
    "muesli-fruits",
    "jus-pomme",
  ]);
}

{
  const parsed = items(
    `Bonjour André

Pourrais- tu nous livrer vendredi en fin d'après-midi:
- 1kg d'asperges de la Lignière
- un panier moyen de fruits bio local
- Si tu as des filets de perches j'en prends aussi.

Bonne journée
Dominique`
  );

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].productId, undefined);
  assert.equal(parsed[0].query, "asperges de la Lignière");
  assert.equal(parsed[0].qty, 1);
  assert.equal(parsed[0].unit, "kg");
  assert.equal(parsed[1].productId, "panier-fruits-local-moyen");
  assert.equal(parsed[1].query, "Panier de FRUITS Bio ou VV 100% Local Moyen");
  assert.equal(parsed[2].productId, "filets-perche");
  assert.equal(parsed[2].query, "Filets de perche congelés");
  assert.equal(parsed.some((item) => item.query.toLowerCase().includes("aussi")), false);
}

{
  const parsed = items(
    "Bonjour André, je veux bien selon dispos :\n- 1 pain noix\n- ⁠1 pain balance \n- ⁠400g lard du begnin\n- ⁠1 grand yaourt brebis nature \n- ⁠1 grand yaourt nature\nMerci bien, Oriana"
  );

  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed.map((item) => item.productId), [
    "pain-noix",
    "pain-balance",
    "lard",
    "yaourt-brebis-grand",
    "yaourt-nature-grand",
  ]);
  assert.equal(parsed[2].qty, 400);
  assert.equal(parsed[2].unit, "g");
  assert.equal(parsed.some((item) => item.productId === "beurre-frais"), false);
  assert.equal(parsed.some((item) => item.productId === "sorbet-fraise"), false);
  assert.equal(parsed.some((item) => item.query.toLowerCase().includes("oriana")), false);
}

{
  const parsed = items("pour cette semaine il me faudrait 3 Mini-pain pu choc");

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].productId, "mini-pain-choc");
  assert.equal(parsed[0].qty, 3);
  assert.equal(parsed.some((item) => item.productId === "mini-sandwich"), false);
  assert.equal(parsed.some((item) => item.productId === "pain-chocolat"), false);
  assert.equal(parsed.some((item) => item.productId === "choco-passion"), false);
  assert.equal(parsed.some((item) => item.productId === "cote-bette"), false);
}

{
  const parsed = items("Salut André. Je te prends volontiers 3l de lait et 2 grands yoghourt Straciatella, si tu en as. Merci!");

  assert.deepEqual(parsed.map((item) => item.productId), [
    "lait-sapalet",
    "yogourt-stracciatella",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [3, 2]);
  assert.deepEqual(parsed.map((item) => item.unit), ["litre", "piece"]);
}

{
  const parsed = items("Salut André. Je te prends volontiers 2 Café en grain décaféiné et 2 Jks d'orange Bio et Penne compqète si tu en as. Merci!");

  assert.deepEqual(parsed.map((item) => item.productId), [
    "cafe-grain-decaf",
    "jus-orange",
    "penne-complete",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [2, 2, 1]);
  assert.equal(parsed.some((item) => item.productId === "oranges-sicile"), false);
  assert.equal(parsed.some((item) => item.productId === "citron-bio"), false);
}

{
  const parsed = items(`Salut André,
Je te prends volontiers un filet de brochet et du Gruyère d'alpage pour la fin de journée.
Merci d'avance.

Belle journée ☀️
Nadia`);

  assert.deepEqual(parsed.map((item) => item.productId), [
    "filet-brochet",
    "gruyere-alpage",
  ]);
}

{
  const parsed = items(`Bonjour
Si ce n’est pas trop tard, puis-je commander
Un pain aux noix
500g rhubarbs
200g lard de begnins
Deux pates vaudois
Deux pizza margaritas and
Une botte chou plume
Un sorbet fraise
Une sauce lulu
Une sauce salvis
Un grand merci`);

  assert.deepEqual(parsed.map((item) => item.productId), [
    "pain-noix",
    "rhubarbe",
    "lard",
    "pate-vaudois",
    "pizza-margarita",
    "chou-plume",
    "sorbet-fraise",
    "sauce-lulu",
    "sauce-salvis",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [1, 500, 200, 2, 2, 1, 1, 1, 1]);
  assert.deepEqual(parsed.map((item) => item.unit), ["piece", "g", "g", "piece", "piece", "piece", "piece", "piece", "piece"]);
}

{
  const parsed = items("pates");

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].productId, "pates-fraiches");
}

{
  const parsed = items("fusilli");

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].productId, "barilla-fusilli");
}

{
  const parsed = items(`Bonjour André, est ce que je pourrais commander 2 fois la pannette mer&terre? Et 1 fois lard de Begnins ?
Si par hasard il reste 2 Birchers de feuillantine ? Sinon ce n’est pas grave 😊 merci beaucoup d’avance`);

  assert.deepEqual(parsed.map((item) => item.productId), [
    "pannette-mer-terre",
    "lard",
    "bircher-feuillantine",
  ]);
  assert.deepEqual(parsed.map((item) => item.qty), [2, 1, 2]);
}

{
  const ranked = rankProductsByQuery("pizza margherita", catalog, 5);
  assert.equal(ranked[0]?.id, "pizza-marguerite");

  const best = matchIngredientToProduct("pizza margherita", ranked);
  assert.equal(best?.id, "pizza-marguerite");
}

{
  const parsed = items("ajoute 1 panier budget 50 à mon panier");

  assert.deepEqual(parsed.map((item) => item.productId), ["panier-budget-50"]);
  assert.equal(parsed[0].qty, 1);
}

{
  const parsed = extractAddItemsFromTextWithCatalog("Deux pizza margaritas and", [
    { id: "pizza-jambon", name: "Pizza Jambon", size: "1 pièce" },
  ]).actions[0].items;

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].productId, undefined);
  assert.equal(parsed[0].query, "pizza margaritas and");
  assert.equal(parsed[0].qty, 2);
}

{
  const parsed = items(`Bonjour
Si ce n’est pas trop tard, puis-je commander
Fdicandeaux
Ballon au pavop
Un grand merci`);

  assert.deepEqual(parsed.map((item) => item.productId), [
    "fricandeaux",
    "ballon-pavot",
  ]);
}

{
  const lard = catalog.find((product) => product.id === "lard")!;
  const pommes = catalog.find((product) => product.id === "pommes")!;
  const jus = catalog.find((product) => product.id === "jus-pomme")!;

  assert.equal(computeBasketQty(lard, 150, "grammes"), 2);
  assert.equal(computeBasketQty(pommes, 2, "kilos"), 2);
  assert.equal(computeBasketQty(jus, 2, "litres"), 2);
}

console.log("add-items-extractor tests passed");
