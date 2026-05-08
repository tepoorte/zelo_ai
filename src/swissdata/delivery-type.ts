export type DeliveryType = {
  id: string;
  name?: string;
  availableRegions?: string[];
  zones?: string;
  useDeliverySlots?: boolean;
};

export type DeliveryTypeSelectionContext = {
  region?: string;
  zip?: string;
  favoriteDeliveryType?: string;
};

export function deliveryTypeZones(deliveryType: DeliveryType | undefined): string[] {
  if (!deliveryType?.zones) return [];
  return deliveryType.zones
    .split(",")
    .map((zone) => zone.trim())
    .filter(Boolean);
}

export function isDeliveryTypeAvailableInRegion(
  deliveryType: DeliveryType | undefined,
  region: string | undefined
): boolean {
  if (!deliveryType) return false;
  const regions = Array.isArray(deliveryType.availableRegions)
    ? deliveryType.availableRegions
    : [];
  return !region || regions.length === 0 || regions.includes(region);
}

export function isDeliveryTypeAvailableInZone(
  deliveryType: DeliveryType | undefined,
  zip: string | undefined
): boolean {
  if (!deliveryType) return false;
  const zones = deliveryTypeZones(deliveryType);
  return !zip || zones.length === 0 || zones.includes(zip);
}

export function isLivraisonDeliveryType(deliveryType: DeliveryType | undefined): boolean {
  const name = deliveryType?.name ?? "";
  return /livraison/i.test(name) && !/retrait|retour|local/i.test(name);
}

export function isSelectableLivraisonDeliveryType(
  deliveryType: DeliveryType | undefined,
  context: DeliveryTypeSelectionContext
): boolean {
  return Boolean(
    deliveryType &&
      deliveryType.useDeliverySlots !== false &&
      isLivraisonDeliveryType(deliveryType) &&
      isDeliveryTypeAvailableInRegion(deliveryType, context.region) &&
      isDeliveryTypeAvailableInZone(deliveryType, context.zip)
  );
}

export function selectLivraisonDeliveryType(
  context: DeliveryTypeSelectionContext,
  deliveryTypes: DeliveryType[]
): string | undefined {
  const favorite = context.favoriteDeliveryType
    ? deliveryTypes.find((deliveryType) => deliveryType.id === context.favoriteDeliveryType)
    : undefined;

  if (isSelectableLivraisonDeliveryType(favorite, context)) {
    return favorite?.id;
  }

  return deliveryTypes.find((deliveryType) =>
    isSelectableLivraisonDeliveryType(deliveryType, context)
  )?.id;
}
