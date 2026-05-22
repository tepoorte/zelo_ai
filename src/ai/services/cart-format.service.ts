import { isBasketDeliveryDateFuture } from "../../swissdata/delivery-date.js";

export function formatCartFr(basket: any): string {
  if (!basket) return "Je n’ai pas pu récupérer ton panier.";

  const products = Array.isArray(basket.products) ? basket.products : [];
  const manualItems = Array.isArray(basket.manualItems) ? basket.manualItems : [];
  const fees = Array.isArray(basket.fees) ? basket.fees : [];
  const currency = basket.currency ?? "";

  const lines: string[] = [];
  lines.push("🧺 Voici ton panier :");

  if (products.length === 0 && manualItems.length === 0) {
    lines.push("• Aucun produit dans le panier pour l’instant.");
  } else {
    for (const product of products) {
      const name =
        product?.name ??
        product?.productName ??
        product?.product?.name ??
        product?.productId ??
        "Produit";
      const quantity = product?.quantity ?? product?.qty ?? 1;
      lines.push(`• ${quantity} × ${name}`);
    }

    for (const item of manualItems) {
      const name = item?.name ?? "Article";
      const quantity = item?.quantity ?? item?.qty ?? 1;
      lines.push(`• ${quantity} × ${name} (manuel)`);
    }
  }

  if (fees.length) {
    lines.push("");
    lines.push("Frais :");
    for (const fee of fees) {
      const price = Number(fee?.paidPriceTTC ?? fee?.paidPrice ?? 0);
      lines.push(`• ${fee?.name ?? "Frais"} : ${price.toFixed(2)} ${currency}`);
    }
  }

  lines.push("");
  if (basket.totalPriceTTC != null) {
    lines.push(`Total TTC : ${Number(basket.totalPriceTTC).toFixed(2)} ${currency}`);
  } else if (basket.totalPrice != null) {
    lines.push(`Total : ${Number(basket.totalPrice).toFixed(2)} ${currency}`);
  }

  if ((products.length > 0 || manualItems.length > 0) && basket.estimatedDeliveryDate) {
    lines.push(
      isBasketDeliveryDateFuture(basket.estimatedDeliveryDate)
        ? `Livraison estimée : ${basket.estimatedDeliveryDate}`
        : "Livraison estimée : à confirmer"
    );
  }

  return lines.join("\n");
}
