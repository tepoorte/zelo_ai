
import { getAllProducts } from "./src/swissdata/products.ts";

const products = await getAllProducts("local-dev");

const sample = products.slice(0, 30).map(p => ({
  id: p.id,
  name: p.name,
  shortDescription: p.shortDescription,
  description: p.description,
  tags: p.tags,
  size: p.size,
  priceType: p.priceType,
  refWeight: p.refWeight,
  refWeightUnit: p.refWeightUnit,
  optionsIds: p.optionsIds,
  metadata: p.metadata,
  categories: p.categories,
  type: p.type,
  unit: p.unit,
  defaultSupplier: p.defaultSupplier
}));

console.log(JSON.stringify(sample, null, 2));
