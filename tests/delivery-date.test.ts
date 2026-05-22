import assert from "node:assert/strict";
import {
  formatEstimatedDeliveryDate,
  isBasketDeliveryDateFuture,
  isDeliverySlotAllowedByOrderingCutoff,
  isDeliverySlotFuture,
  minDeliveryDayDiff,
  parseBasketDeliveryDate,
  sortFutureDeliverySlots,
  sortSelectableDeliverySlots,
} from "../src/swissdata/delivery-date.js";
import { selectLivraisonDeliveryType } from "../src/swissdata/delivery-type.js";
import { formatCartFr } from "../src/ai/services/cart-format.service.js";

const NOW = new Date(2026, 4, 6, 14, 25, 0, 0);

function run(): void {
  const pastDelivery = parseBasketDeliveryDate("16-04-2026 08:00");
  assert(pastDelivery, "Expected Swiss delivery date to be parsed");
  assert.equal(
    isBasketDeliveryDateFuture("16-04-2026 08:00", NOW),
    false,
    "Past estimated delivery dates must not be treated as valid"
  );
  assert.equal(
    isBasketDeliveryDateFuture("08-05-2026 08:00", NOW),
    true,
    "Future estimated delivery dates must stay valid"
  );
  assert.equal(
    formatEstimatedDeliveryDate("2026-05-09", 8 * 60),
    "09-05-2026 08:00",
    "Delivery slots should be displayed in the basket format"
  );
  assert.equal(
    isDeliverySlotFuture({ id: "old", date: "2026-04-16", timeStart: 8 * 60 } as any, NOW),
    false,
    "Old slots returned by Swissdata must be ignored"
  );
  assert.equal(
    isDeliverySlotFuture({ id: "next", date: "2026-05-09", timeStart: 8 * 60 } as any, NOW),
    true,
    "The next available future slot should be accepted"
  );
  assert.deepEqual(
    sortFutureDeliverySlots(
      [
        { id: "late", date: "2026-05-09", timeStart: 17 * 60 },
        { id: "old", date: "2026-04-16", timeStart: 8 * 60 },
        { id: "first", date: "2026-05-08", timeStart: 9 * 60 },
      ],
      NOW
    ).map((slot) => slot.id),
    ["first", "late"],
    "Delivery slot selection must use real future slots sorted by date, without generating fallback slots"
  );
  assert.deepEqual(
    sortFutureDeliverySlots([], NOW),
    [],
    "No fallback slot should be synthesized when Swissdata has no future slot"
  );
  assert.equal(
    isDeliverySlotAllowedByOrderingCutoff(
      { id: "same-day", date: "06-05-2026", timeStart: 17 * 60 } as any,
      NOW
    ),
    false,
    "Same-day slots should follow the official Zelo ordering cutoff"
  );
  assert.deepEqual(
    sortSelectableDeliverySlots(
      [
        { id: "same-day", date: "06-05-2026", timeStart: 17 * 60 },
        { id: "tomorrow", date: "07-05-2026", timeStart: 8 * 60 },
      ],
      NOW
    ).map((slot) => slot.id),
    ["tomorrow"],
    "The selected delivery slot should be the first orderable slot, not just the first future slot"
  );
  const AFTER_CUTOFF_ZURICH = new Date(Date.UTC(2026, 4, 6, 14, 4, 0, 0));
  assert.equal(
    minDeliveryDayDiff(AFTER_CUTOFF_ZURICH),
    2,
    "The ordering cutoff must use Europe/Zurich, even when the server runs in UTC"
  );
  assert.deepEqual(
    sortSelectableDeliverySlots(
      [
        { id: "tomorrow", date: "07-05-2026", timeStart: 8 * 60 },
        { id: "after-tomorrow", date: "08-05-2026", timeStart: 9 * 60 },
      ],
      AFTER_CUTOFF_ZURICH
    ).map((slot) => slot.id),
    ["after-tomorrow"],
    "After the Zurich cutoff, tomorrow's slots should not be selected"
  );

  const formattedCart = formatCartFr({
    currency: "CHF",
    products: [{ name: "Oeuf Bio à la pièce", quantity: 2 }],
    fees: [],
    totalPriceTTC: 12.11,
    estimatedDeliveryDate: "16-04-2026 08:00",
  });

  assert(
    !formattedCart.includes("Livraison estimée : 16-04-2026 08:00"),
    "The assistant response must never show a stale delivery date"
  );
  assert(
    formattedCart.includes("Livraison estimée : à confirmer"),
    "A stale date should fall back to a safe confirmation label"
  );

  const deliveryTypes = [
    {
      id: "retrait",
      name: "Retrait au local",
      availableRegions: ["region-a"],
      zones: "",
      useDeliverySlots: true,
    },
    {
      id: "gland",
      name: "Livraison Gland/Vich/Dully",
      availableRegions: ["region-a"],
      zones: "1195,1196,1267",
      useDeliverySlots: true,
    },
    {
      id: "nyon",
      name: "Livraison Nyon/Prangins/Duillier/Crans/Eysins/Signy",
      availableRegions: ["region-a"],
      zones: "1197,1260,1262,1266,1274,1299",
      useDeliverySlots: true,
    },
  ];

  assert.equal(
    selectLivraisonDeliveryType(
      { region: "region-a", zip: "1196", favoriteDeliveryType: "gland" },
      deliveryTypes
    ),
    "gland",
    "Gland customers should use the Gland livraison type"
  );

  assert.equal(
    selectLivraisonDeliveryType(
      { region: "region-a", zip: "1196", favoriteDeliveryType: "retrait" },
      deliveryTypes
    ),
    "gland",
    "Retrait au local must not be selected as a livraison estimate"
  );

  assert.equal(
    selectLivraisonDeliveryType(
      { region: "region-a", zip: "1260" },
      deliveryTypes
    ),
    "nyon",
    "Nyon customers should use the Nyon livraison type"
  );

  assert.equal(
    selectLivraisonDeliveryType(
      { region: "region-a", zip: "1024", favoriteDeliveryType: "retrait" },
      deliveryTypes
    ),
    undefined,
    "Unsupported ZIP codes should not fall back to Retrait au local"
  );
}

run();
console.log("[PASS] delivery-date guards");
