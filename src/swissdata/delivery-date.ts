type DeliverySlotLike = {
  date?: string;
  timeStart?: number;
};

const ZELO_TIME_ZONE = "Europe/Zurich";
const DAY_MS = 86_400_000;

function buildLocalDate(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number
): Date | null {
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) {
    return null;
  }
  return date;
}

function getZurichDateParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZELO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
  };
}

function parseSlotCalendarDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().slice(0, 10);

  const swissMatch = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (swissMatch) {
    return {
      year: Number(swissMatch[3]),
      month: Number(swissMatch[2]),
      day: Number(swissMatch[1]),
    };
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
  }

  return null;
}

function utcDayNumber(parts: { year: number; month: number; day: number }): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}

export function parseBasketDeliveryDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;

  const raw = value.trim();
  if (!raw) return null;

  const swissMatch = raw.match(
    /^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/
  );
  if (swissMatch) {
    const [, day, month, year, hours = "0", minutes = "0"] = swissMatch;
    return buildLocalDate(
      Number(year),
      Number(month),
      Number(day),
      Number(hours),
      Number(minutes)
    );
  }

  const isoMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/
  );
  if (isoMatch) {
    const [, year, month, day, hours = "0", minutes = "0"] = isoMatch;
    return buildLocalDate(
      Number(year),
      Number(month),
      Number(day),
      Number(hours),
      Number(minutes)
    );
  }

  return null;
}

export function isBasketDeliveryDateFuture(
  value: unknown,
  now: Date = new Date()
): boolean {
  const deliveryDate = parseBasketDeliveryDate(value);
  return Boolean(deliveryDate && deliveryDate.getTime() > now.getTime());
}

export function formatEstimatedDeliveryDate(
  dateValue: string,
  timeStart: number
): string {
  const raw = String(dateValue ?? "").slice(0, 10);
  const normalized = /^\d{2}-\d{2}-\d{4}$/.test(raw)
    ? raw
    : (() => {
        const [year, month, day] = raw.split("-");
        return `${day}-${month}-${year}`;
      })();
  const hours = String(Math.floor(timeStart / 60)).padStart(2, "0");
  const minutes = String(timeStart % 60).padStart(2, "0");
  return `${normalized} ${hours}:${minutes}`;
}

export function parseDeliverySlotDate(slot: DeliverySlotLike): Date | null {
  if (!slot?.date || !Number.isFinite(Number(slot.timeStart))) return null;
  return parseBasketDeliveryDate(
    formatEstimatedDeliveryDate(String(slot.date), Number(slot.timeStart))
  );
}

export function isDeliverySlotFuture(
  slot: DeliverySlotLike,
  now: Date = new Date()
): boolean {
  const slotDate = parseDeliverySlotDate(slot);
  return Boolean(slotDate && slotDate.getTime() > now.getTime());
}

export function minDeliveryDayDiff(now: Date = new Date()): number {
  return getZurichDateParts(now).hour <= 15 ? 1 : 2;
}

export function isDeliverySlotAllowedByOrderingCutoff(
  slot: DeliverySlotLike,
  now: Date = new Date()
): boolean {
  const slotDay = parseSlotCalendarDate(slot?.date);
  if (!slotDay) return false;

  const today = getZurichDateParts(now);
  const dayDiff = utcDayNumber(slotDay) - utcDayNumber(today);
  return dayDiff >= minDeliveryDayDiff(now);
}

export function sortFutureDeliverySlots<T extends DeliverySlotLike>(
  slots: T[],
  now: Date = new Date()
): T[] {
  return slots
    .filter((slot) => isDeliverySlotFuture(slot, now))
    .sort((left, right) => {
      const leftTime = parseDeliverySlotDate(left)?.getTime() ?? Number.POSITIVE_INFINITY;
      const rightTime = parseDeliverySlotDate(right)?.getTime() ?? Number.POSITIVE_INFINITY;
      return leftTime - rightTime;
    });
}

export function sortSelectableDeliverySlots<T extends DeliverySlotLike>(
  slots: T[],
  now: Date = new Date()
): T[] {
  return sortFutureDeliverySlots(slots, now).filter((slot) =>
    isDeliverySlotAllowedByOrderingCutoff(slot, now)
  );
}
