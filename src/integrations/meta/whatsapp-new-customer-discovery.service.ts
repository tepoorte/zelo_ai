import { formatCartFr } from "../../ai/services/cart-format.service.js";
import { isAssistantProductEligible } from "../../ai/product-eligibility.js";
import { env } from "../../config/env.js";
import { swissdataAdminClient } from "../../swissdata/admin-client.js";
import {
  getCurrentBasket,
  setProductQuantityInBasket,
} from "../../swissdata/cart.js";
import {
  fetchProductById,
  isProductAvailableInRegion,
  type Product,
} from "../../swissdata/products.js";
import { requireWhatsAppCustomerSession } from "../../swissdata/whatsapp-customer-session.js";
import { sendWhatsAppText } from "./whatsapp.send.js";

export const STANDARD_DISCOVERY_BASKET_PRODUCT_ID = "5f087031b913a30006e5a3e6";
export const LARGE_DISCOVERY_BASKET_PRODUCT_ID = "5f087106b913a30006e5a3e7";
export const NEW_CUSTOMER_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

type DiscoveryBasketKind = "standard" | "large";
type DiscoveryPhase = "choice" | "confirmation";

type DiscoveryBasketDefinition = {
  kind: DiscoveryBasketKind;
  choice: "1" | "2";
  productId: string;
  household: string;
};

type ValidDiscoveryBasket = DiscoveryBasketDefinition & {
  name: string;
  composition: string | null;
  priceTtc: number;
};

type DiscoveryState = {
  userRef: string;
  regionId: string;
  phase: DiscoveryPhase;
  offered: DiscoveryBasketDefinition[];
  selected?: DiscoveryBasketDefinition;
  expiresAt: number;
};

type RecentCompletion = {
  message: string;
  confirmationToken: string;
  expiresAt: number;
};

type CancellationGeneration = {
  value: number;
  expiresAt: number;
};

export type WhatsAppNewCustomerDiscoveryDeps = {
  now: () => number;
  fetchProduct: (userRef: string, productId: string) => Promise<Product | null>;
  getCustomerRegion: (userRef: string) => Promise<string | null>;
  getBasket: (userRef: string) => Promise<any>;
  setProductQuantity: (
    userRef: string,
    basketId: string,
    productId: string,
    quantity: number,
    optionsIds?: string[]
  ) => Promise<any>;
  sendText: typeof sendWhatsAppText;
};

export type SendNewCustomerDiscoveryWelcomeInput = {
  userRef: string;
  phone: string;
  regionId: string;
};

export type SendNewCustomerDiscoveryWelcomeResult = {
  sent: true;
  offered: boolean;
  message: string;
};

export type HandleNewCustomerDiscoveryMessageInput = {
  userRef: string;
  text: string;
};

const DISCOVERY_BASKETS: readonly DiscoveryBasketDefinition[] = Object.freeze([
  Object.freeze({
    kind: "standard" as const,
    choice: "1" as const,
    productId: STANDARD_DISCOVERY_BASKET_PRODUCT_ID,
    household: "1–2 personnes",
  }),
  Object.freeze({
    kind: "large" as const,
    choice: "2" as const,
    productId: LARGE_DISCOVERY_BASKET_PRODUCT_ID,
    household: "3–4 personnes",
  }),
]);

const DEFAULT_DEPS: WhatsAppNewCustomerDiscoveryDeps = {
  now: () => Date.now(),
  fetchProduct: fetchProductById,
  getCustomerRegion: fetchCurrentCustomerRegion,
  getBasket: getCurrentBasket,
  setProductQuantity: setProductQuantityInBasket,
  sendText: sendWhatsAppText,
};

function referencedId(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return referencedId(record.id ?? record._id);
  }
  return "";
}

async function fetchCurrentCustomerRegion(userRef: string): Promise<string | null> {
  const session = requireWhatsAppCustomerSession(userRef);
  if (!env.swissdataShopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const api = await swissdataAdminClient();
  const response = await api.get(
    `/shop/admin/${env.swissdataShopId}/customer/${encodeURIComponent(session.customerId)}`
  );
  return referencedId(response.data?.region) || null;
}

function normalizedReply(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isPromoConfirmation(value: string): boolean {
  return new Set(["oui", "je confirme"]).has(normalizedReply(value));
}

function isNegative(value: string): boolean {
  return new Set([
    "non",
    "no",
    "annule",
    "annuler",
    "pas maintenant",
    "plus tard",
    "non merci",
  ]).has(normalizedReply(value));
}

function selectedChoice(value: string): "1" | "2" | null {
  const normalized = normalizedReply(value);
  if (normalized === "1" || normalized === "panier 1" || normalized === "choix 1") return "1";
  if (normalized === "2" || normalized === "panier 2" || normalized === "choix 2") return "2";
  return null;
}

function readableNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function productPriceTtc(product: Product): number | null {
  if (!product.price || typeof product.price !== "object") return null;
  const net = readableNumber(product.price.price);
  const vat = readableNumber(product.price.vat);
  if (net == null || net <= 0 || vat == null || vat < 0 || vat > 1) return null;
  return Math.round(net * (1 + vat) * 100) / 100;
}

function plainCatalogText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const plain = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length <= 500 ? plain : `${plain.slice(0, 497).trimEnd()}…`;
}

function displayProductName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.trim().replace(/^A\.\s*/i, "") : "";
  return name || fallback;
}

function basketIdOf(basket: any): string {
  return String(basket?.id ?? basket?._id ?? "").trim();
}

function formatTtc(value: number): string {
  return value.toFixed(2);
}

function normalWelcome(): string {
  return [
    "✅ *Compte Zélo créé et connecté*",
    "",
    "Tu peux revenir ici et utiliser l’assistant.",
    "Essaie par exemple : « ajoute un pain » ou « propose-moi une idée pour ce soir ».",
  ].join("\n");
}

function formatChoiceLines(baskets: readonly ValidDiscoveryBasket[]): string[] {
  return baskets.map(
    (basket) =>
      `${basket.choice}. *${basket.name}* — ${basket.household} — ${formatTtc(basket.priceTtc)} CHF TTC`
  );
}

function discoveryWelcome(baskets: readonly ValidDiscoveryBasket[]): string {
  return [
    "✅ *Compte Zélo créé et connecté*",
    "",
    "Bienvenue ! Pour découvrir Zélo, tu peux ajouter facultativement un panier découverte à ton panier :",
    ...formatChoiceLines(baskets),
    "",
    `Réponds ${baskets.map((basket) => `« ${basket.choice} »`).join(" ou ")}, ou « non ».`,
    "Rien ne sera commandé automatiquement.",
  ].join("\n");
}

function choiceReminder(baskets: readonly ValidDiscoveryBasket[]): string {
  return [
    "Choisis d’abord le panier découverte qui t’intéresse :",
    ...formatChoiceLines(baskets),
    "",
    `Réponds ${baskets.map((basket) => `« ${basket.choice} »`).join(" ou ")}, ou « non ».`,
  ].join("\n");
}

function confirmationPrompt(basket: ValidDiscoveryBasket): string {
  return [
    "*Panier découverte sélectionné*",
    `• ${basket.name} (${basket.household})`,
    `• Prix actuel : ${formatTtc(basket.priceTtc)} CHF TTC`,
    ...(basket.composition ? [`• Composition actuelle : ${basket.composition}`] : []),
    "",
    "Veux-tu fixer sa quantité à 1 dans ton panier ? Réponds « oui » ou « non ».",
    "Cette confirmation ajoute seulement le produit au panier : elle ne passe aucune commande.",
  ].join("\n");
}

function temporarilyUnavailable(): string {
  return [
    "Je n’arrive pas à vérifier ce panier découverte pour le moment.",
    "Réessaie dans un instant, ou réponds « non » pour continuer sans cette proposition.",
  ].join("\n");
}

export class WhatsAppNewCustomerDiscoveryService {
  private readonly states = new Map<string, DiscoveryState>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly recentCompletions = new Map<string, RecentCompletion>();
  private readonly cancellationGenerations = new Map<string, CancellationGeneration>();

  constructor(
    private readonly deps: WhatsAppNewCustomerDiscoveryDeps = DEFAULT_DEPS,
    private readonly ttlMs = NEW_CUSTOMER_DISCOVERY_TTL_MS
  ) {}

  private async runExclusive<T>(userRef: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userRef) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(userRef, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(userRef) === current) this.locks.delete(userRef);
    }
  }

  private activeState(userRef: string): DiscoveryState | null {
    const state = this.states.get(userRef);
    if (!state) return null;
    if (state.expiresAt <= this.deps.now()) {
      this.states.delete(userRef);
      return null;
    }
    return state;
  }

  private recentCompletion(userRef: string): RecentCompletion | null {
    const completion = this.recentCompletions.get(userRef);
    if (!completion) return null;
    if (completion.expiresAt <= this.deps.now()) {
      this.recentCompletions.delete(userRef);
      return null;
    }
    return completion;
  }

  private sweepExpired(): void {
    const now = this.deps.now();
    for (const [userRef, state] of this.states) {
      if (state.expiresAt <= now) this.states.delete(userRef);
    }
    for (const [userRef, completion] of this.recentCompletions) {
      if (completion.expiresAt <= now) this.recentCompletions.delete(userRef);
    }
    for (const [userRef, generation] of this.cancellationGenerations) {
      if (generation.expiresAt <= now) this.cancellationGenerations.delete(userRef);
    }
  }

  private cancellationGenerationFor(userRef: string): number {
    const generation = this.cancellationGenerations.get(userRef);
    if (!generation) return 0;
    if (generation.expiresAt <= this.deps.now()) {
      this.cancellationGenerations.delete(userRef);
      return 0;
    }
    return generation.value;
  }

  private async validateBasket(
    userRef: string,
    regionId: string,
    definition: DiscoveryBasketDefinition
  ): Promise<ValidDiscoveryBasket | null> {
    const product = await this.deps.fetchProduct(userRef, definition.productId);
    if (String(product?.id ?? "").trim() !== definition.productId) return null;
    if (!product || !isAssistantProductEligible(product)) return null;
    if (!isProductAvailableInRegion(product, regionId)) return null;
    if (
      (Array.isArray(product.optionsIds) && product.optionsIds.length > 0) ||
      (Array.isArray(product.availableOptions) && product.availableOptions.length > 0)
    ) {
      return null;
    }
    const priceTtc = productPriceTtc(product);
    if (priceTtc == null) return null;

    return {
      ...definition,
      name: displayProductName(
        product.name,
        definition.kind === "standard" ? "Panier découverte" : "Grand panier découverte"
      ),
      // The live short description currently carries only a scheduling note;
      // the full description is the catalog source for the basket composition.
      composition: plainCatalogText(product.description ?? product.shortDescription),
      priceTtc,
    };
  }

  private async currentlyValidBaskets(state: DiscoveryState): Promise<ValidDiscoveryBasket[]> {
    const regionId = await this.deps.getCustomerRegion(state.userRef);
    if (!regionId) return [];
    const settled = await Promise.allSettled(
      state.offered.map((definition) =>
        this.validateBasket(state.userRef, regionId, definition)
      )
    );
    return settled.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : []
    );
  }

  async sendWelcomeAndArm(
    input: SendNewCustomerDiscoveryWelcomeInput
  ): Promise<SendNewCustomerDiscoveryWelcomeResult> {
    const cancellationGeneration = this.cancellationGenerationFor(input.userRef);
    return await this.runExclusive(input.userRef, async () => {
      this.sweepExpired();
      this.states.delete(input.userRef);
      this.recentCompletions.delete(input.userRef);

      const candidateState: DiscoveryState = {
        userRef: input.userRef,
        regionId: String(input.regionId ?? "").trim(),
        phase: "choice",
        offered: [...DISCOVERY_BASKETS],
        expiresAt: this.deps.now() + this.ttlMs,
      };
      let baskets: ValidDiscoveryBasket[] = [];
      if (candidateState.regionId) {
        try {
          baskets = await this.currentlyValidBaskets(candidateState);
        } catch {
          // Account creation already succeeded. If the current region/catalog
          // cannot be re-read, keep the normal welcome and do not arm a flow.
        }
      }
      const message = baskets.length ? discoveryWelcome(baskets) : normalWelcome();

      await this.deps.sendText({
        to: input.phone,
        body: message,
        previewUrl: false,
      });

      if (
        baskets.length &&
        this.cancellationGenerationFor(input.userRef) === cancellationGeneration
      ) {
        candidateState.offered = baskets.map(({ name: _name, composition: _composition, priceTtc: _price, ...definition }) => definition);
        this.states.set(input.userRef, candidateState);
      }

      return {
        sent: true,
        offered:
          baskets.length > 0 &&
          this.cancellationGenerationFor(input.userRef) === cancellationGeneration,
        message,
      };
    });
  }

  async handleMessage(input: HandleNewCustomerDiscoveryMessageInput): Promise<string | null> {
    this.sweepExpired();
    const cancellationGeneration = this.cancellationGenerationFor(input.userRef);
    return await this.runExclusive(input.userRef, async () => {
      this.sweepExpired();
      const state = this.activeState(input.userRef);
      if (!state) {
        const completion = this.recentCompletion(input.userRef);
        const token = normalizedReply(input.text);
        if (
          completion &&
          token === completion.confirmationToken
        ) {
          return completion.message;
        }
        this.recentCompletions.delete(input.userRef);
        return null;
      }

      if (isNegative(input.text)) {
        this.states.delete(input.userRef);
        return "D’accord, aucun panier découverte n’a été ajouté. Tu peux utiliser l’assistant normalement.";
      }

      const choice = selectedChoice(input.text);

      if (state.phase === "choice") {
        if (!choice) {
          if (!isPromoConfirmation(input.text)) {
            this.states.delete(input.userRef);
            return null;
          }
          try {
            const baskets = await this.currentlyValidBaskets(state);
            if (!baskets.length) {
              this.states.delete(input.userRef);
              return "Les paniers découverte ne sont plus disponibles pour le moment. Tu peux utiliser l’assistant normalement.";
            }
            return choiceReminder(baskets);
          } catch {
            return temporarilyUnavailable();
          }
        }

        const definition = state.offered.find((basket) => basket.choice === choice);
        if (!definition) {
          this.states.delete(input.userRef);
          return null;
        }
        try {
          const regionId = await this.deps.getCustomerRegion(state.userRef);
          const basket = regionId
            ? await this.validateBasket(state.userRef, regionId, definition)
            : null;
          if (
            this.cancellationGenerationFor(input.userRef) !== cancellationGeneration
          ) {
            return null;
          }
          if (!basket) {
            state.offered = state.offered.filter((candidate) => candidate.productId !== definition.productId);
            const alternatives = await this.currentlyValidBaskets(state);
            if (!alternatives.length) {
              this.states.delete(input.userRef);
              return "Ce panier découverte n’est plus disponible. Tu peux utiliser l’assistant normalement.";
            }
            return [
              "Ce panier découverte n’est plus disponible.",
              "",
              choiceReminder(alternatives),
            ].join("\n");
          }
          state.phase = "confirmation";
          state.selected = definition;
          return confirmationPrompt(basket);
        } catch {
          return temporarilyUnavailable();
        }
      }

      if (choice) {
        const definition = state.offered.find((basket) => basket.choice === choice);
        if (!definition) {
          this.states.delete(input.userRef);
          return null;
        }
        try {
          const regionId = await this.deps.getCustomerRegion(state.userRef);
          const basket = regionId
            ? await this.validateBasket(state.userRef, regionId, definition)
            : null;
          if (
            this.cancellationGenerationFor(input.userRef) !== cancellationGeneration
          ) {
            return null;
          }
          if (!basket) {
            this.states.delete(input.userRef);
            return "Ce panier découverte n’est plus disponible. Tu peux utiliser l’assistant normalement.";
          }
          state.selected = definition;
          return confirmationPrompt(basket);
        } catch {
          return temporarilyUnavailable();
        }
      }

      if (!isPromoConfirmation(input.text)) {
        this.states.delete(input.userRef);
        return null;
      }

      const selected = state.selected;
      if (!selected) {
        state.phase = "choice";
        const baskets = await this.currentlyValidBaskets(state);
        return baskets.length ? choiceReminder(baskets) : null;
      }

      try {
        const regionId = await this.deps.getCustomerRegion(state.userRef);
        const product = regionId
          ? await this.validateBasket(state.userRef, regionId, selected)
          : null;
        if (
          this.cancellationGenerationFor(input.userRef) !== cancellationGeneration
        ) {
          return null;
        }
        if (!product) {
          this.states.delete(input.userRef);
          return "Ce panier découverte n’est plus disponible. Rien n’a été ajouté à ton panier.";
        }

        const basket = await this.deps.getBasket(state.userRef);
        const basketId = basketIdOf(basket);
        if (!basketId) throw new Error("Current basket has no identifier");
        if (
          this.cancellationGenerationFor(input.userRef) !== cancellationGeneration
        ) {
          return null;
        }

        await this.deps.setProductQuantity(
          state.userRef,
          basketId,
          selected.productId,
          1,
          []
        );
        const updatedBasket = await this.deps.getBasket(state.userRef);
        const message = [
          `✅ La quantité de « ${product.name} » est maintenant fixée à 1 dans ton panier.`,
          "",
          formatCartFr(updatedBasket),
          "",
          "Aucune commande n’a été passée. Tu peux encore modifier ton panier ou écrire « ok » lorsque tu voudras commander.",
        ].join("\n");

        if (
          this.cancellationGenerationFor(input.userRef) === cancellationGeneration
        ) {
          this.states.delete(input.userRef);
          this.recentCompletions.set(input.userRef, {
            message,
            confirmationToken: normalizedReply(input.text),
            expiresAt: this.deps.now() + Math.min(this.ttlMs, 5 * 60_000),
          });
        }
        return message;
      } catch {
        return temporarilyUnavailable();
      }
    });
  }

  async clear(userRef: string): Promise<void> {
    const now = this.deps.now();
    this.cancellationGenerations.set(
      userRef,
      {
        value: this.cancellationGenerationFor(userRef) + 1,
        expiresAt: now + Math.max(this.ttlMs, 5 * 60_000),
      }
    );
    this.sweepExpired();
    await this.runExclusive(userRef, async () => {
      this.states.delete(userRef);
      this.recentCompletions.delete(userRef);
    });
  }

  hasActiveState(userRef: string): boolean {
    this.sweepExpired();
    return this.activeState(userRef) != null;
  }
}

export const whatsappNewCustomerDiscoveryService =
  new WhatsAppNewCustomerDiscoveryService();

export async function sendWhatsAppNewCustomerDiscoveryWelcome(
  input: SendNewCustomerDiscoveryWelcomeInput
): Promise<SendNewCustomerDiscoveryWelcomeResult> {
  return await whatsappNewCustomerDiscoveryService.sendWelcomeAndArm(input);
}

export async function handleWhatsAppNewCustomerDiscoveryMessage(
  input: HandleNewCustomerDiscoveryMessageInput
): Promise<string | null> {
  return await whatsappNewCustomerDiscoveryService.handleMessage(input);
}

export async function clearWhatsAppNewCustomerDiscovery(userRef: string): Promise<void> {
  await whatsappNewCustomerDiscoveryService.clear(userRef);
}
