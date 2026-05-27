#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover - optional in local dev
    np = None

try:
    from sklearn.linear_model import LogisticRegression  # type: ignore
    from sklearn.multiclass import OneVsRestClassifier  # type: ignore
except Exception:  # pragma: no cover - optional in local dev
    LogisticRegression = None
    OneVsRestClassifier = None


ROOT = Path.cwd()
TRAINING_DIR = ROOT / "ml" / "discover-meals"
CACHE_DIR = ROOT / ".cache"
OUTPUT_PATH = CACHE_DIR / "discover-meals-model.json"
CATALOG_PATH = CACHE_DIR / "catalog-local-dev.json"
CATALOG_EMBEDDINGS_PATH = CACHE_DIR / "catalog-embeddings-local-dev.json"
DISCOVER_EMBEDDINGS_PATH = CACHE_DIR / "discover-meals-embeddings.json"

BASE_LABELS = [
    "aperitif",
    "balanced",
    "breakfast",
    "budget",
    "cleaning",
    "dessert",
    "dinner",
    "discovery_open",
    "drink",
    "gift",
    "healthy",
    "hygiene",
    "kids",
    "local",
    "quick",
    "vegetarian",
    "weekly_basket",
    "zero_waste",
]
LABELS = list(BASE_LABELS)

ROLE_BY_CATEGORY = {
    "5dcfc1616f4a93324a0a2b1a": ["dairy"],
    "5dcfddcb6f4a93324a0a2b1e": ["bakery"],
    "5dcfde1f6f4a93324a0a2b1f": ["vegetable"],
    "5dcfde5d6f4a93324a0a2b20": ["grain"],
    "5dcfdec16f4a93324a0a2b21": ["starch", "grain"],
    "5dcfdf0e6f4a93324a0a2b22": ["protein"],
    "5dcfdf4c6f4a93324a0a2b23": ["condiment"],
    "5f00d2cda5761c0007833362": ["prepared_meal", "menu"],
    "5dea5c3d7e6ac104dac9fde2": ["drink"],
    "5dcfdf736f4a93324a0a2b24": ["hygiene"],
    "5dcfdf906f4a93324a0a2b25": ["cleaning"],
}

CATEGORY_NAME_BY_ID = {
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
}

FOOD_CATEGORIES = {
    "5dcfc1616f4a93324a0a2b1a",
    "5dcfddcb6f4a93324a0a2b1e",
    "5dcfde1f6f4a93324a0a2b1f",
    "5dcfde5d6f4a93324a0a2b20",
    "5dcfdec16f4a93324a0a2b21",
    "5dcfdf0e6f4a93324a0a2b22",
    "5dcfdf4c6f4a93324a0a2b23",
    "5f00d2cda5761c0007833362",
    "5dea5c3d7e6ac104dac9fde2",
}

NEED_ROLE_PRIORITY = {
    "aperitif": ["aperitif", "cheese", "meat", "bread", "condiment", "drink", "snack"],
    "balanced": ["protein", "vegetable", "fruit", "starch", "grain", "dairy"],
    "breakfast": ["breakfast", "bread", "grain", "dairy", "fruit", "drink"],
    "budget": ["starch", "bread", "grain", "egg", "dairy", "basket"],
    "cleaning": ["cleaning"],
    "dessert": ["dessert", "sweet", "fruit", "dairy", "bakery"],
    "dinner": ["protein", "starch", "vegetable", "prepared_meal", "sauce"],
    "discovery_open": ["protein", "vegetable", "fruit", "bread", "dairy", "starch"],
    "drink": ["drink"],
    "gift": ["gift", "dessert", "sweet", "drink"],
    "healthy": ["fruit", "vegetable", "protein", "grain", "starch", "dairy"],
    "hygiene": ["hygiene"],
    "kids": ["breakfast", "dairy", "bread", "fruit", "dessert"],
    "local": ["cheese", "bread", "vegetable", "fruit", "meat", "fish"],
    "quick": ["prepared_meal", "menu", "bread", "dairy", "sauce"],
    "vegetarian": ["egg", "cheese", "dairy", "vegetable", "starch", "grain"],
    "weekly_basket": ["basket", "bread", "dairy", "fruit", "vegetable", "starch"],
    "zero_waste": ["vegetable", "fruit", "bread", "dairy", "basket"],
}

ANCHOR_POLICIES = {
    "fruit": {
        "mode": "strict_domain",
        "blockedRoles": [
            "aperitif",
            "bakery",
            "bread",
            "dessert",
            "drink",
            "grain",
            "meat",
            "menu",
            "oil",
            "prepared_meal",
            "fish",
            "snack",
            "starch",
            "sweet",
            "vegetable",
            "cleaning",
            "hygiene",
        ],
    },
    "drink": {
        "mode": "strict_domain",
        "blockedRoles": ["meat", "fish", "egg", "starch", "vegetable", "cleaning", "hygiene", "prepared_meal", "menu"],
    },
    "dessert": {
        "mode": "strict_domain",
        "blockedRoles": ["meat", "fish", "cleaning", "hygiene"],
    },
    "cleaning": {
        "mode": "strict_domain",
        "blockedRoles": ["meat", "fish", "fruit", "vegetable", "starch", "dairy", "drink", "dessert"],
    },
    "hygiene": {
        "mode": "strict_domain",
        "blockedRoles": ["meat", "fish", "fruit", "vegetable", "starch", "dairy", "drink", "dessert"],
    },
    "gift": {
        "mode": "strict_domain",
        "blockedRoles": ["cleaning", "hygiene"],
    },
    "meat": {
        "mode": "composable",
        "complementRoles": ["starch", "grain", "vegetable", "oil", "sauce", "condiment", "bread"],
        "blockedRoles": ["fish"],
    },
    "fish": {
        "mode": "composable",
        "complementRoles": ["starch", "grain", "vegetable", "oil", "sauce", "condiment", "bread"],
        "blockedRoles": ["meat"],
    },
    "egg": {
        "mode": "composable",
        "complementRoles": ["bread", "vegetable", "starch", "grain", "cheese", "dairy"],
    },
    "cheese": {
        "mode": "composable",
        "complementRoles": ["bread", "vegetable", "starch", "grain", "meat"],
    },
    "prepared_meal": {
        "mode": "composable",
        "complementRoles": ["vegetable", "drink", "sauce", "condiment"],
    },
}

ROLE_PATTERNS = [
    (r"\b(oeuf|oeufs)\b", ["egg", "protein", "breakfast"]),
    (r"\b(lait|yaourt|yogourt|yoghourt|brebis)\b", ["dairy", "breakfast"]),
    (r"\b(fromage|gruyere|crottin|mozzarella|raclette)\b", ["cheese", "dairy", "protein", "aperitif"]),
    (r"\b(pain|baguette|toast|bun)\b", ["bread", "bakery"]),
    (r"\b(muesli|cereale|cereales|granola|flocon)\b", ["grain", "breakfast"]),
    (r"\b(riz|pates|pasta|maccheroni|spaghetti|fusilli|penne|polenta|semoule)\b", ["starch", "grain", "pantry"]),
    (r"\b(pomme de terre|patate|pdt)\b", ["starch", "vegetable"]),
    (r"\b(pomme|pommes|poire|poires|fraise|fraises|ananas|orange|oranges|citron|citrons|banane|bananes|mangue|mangues|raisin|raisins|cranberr|fruit|fruits)\b", ["fruit"]),
    (r"\b(salade|legume|legumes|carotte|tomate|courgette|asperge|chou|rhubarbe|bette)\b", ["vegetable"]),
    (r"\b(poulet|boeuf|porc|veau|dinde|lard|jambon|saucisse|salami|viande)\b", ["meat", "protein"]),
    (r"\b(poisson|perche|perches|brochet|fera)\b", ["fish", "protein"]),
    (r"\b(tofu|lentille|pois chiche|haricot)\b", ["protein"]),
    (r"\b(sauce|ketchup|moutarde|mayonnaise|salvis|lulu)\b", ["sauce", "condiment"]),
    (r"\b(huile|vinaigre)\b", ["oil", "condiment"]),
    (r"\b(sel|poivre|epice|epices)\b", ["condiment", "pantry"]),
    (r"\b(pizza|menu|plat|pannette)\b", ["prepared_meal", "menu"]),
    (r"\b(chocolat|sorbet|glace|tarte|gateau|biscuit|cookie|dessert|sucre|miel)\b", ["dessert", "sweet"]),
    (r"\b(biere|vin|cidre|alcool)\b", ["alcohol", "drink"]),
    (r"\b(jus|sirop|biere|vin|cidre|cafe|the|boir|boire|boisson|boissons)\b", ["drink"]),
    (r"\b(chips|aperitif|apero|cacahuete|noix|olive)\b", ["aperitif", "snack"]),
    (r"\b(cadeau|coffret|bouquet)\b", ["gift"]),
    (r"\b(savon|shampoing|dentifrice|cosmetique|hygiene)\b", ["hygiene"]),
    (r"\b(menage|lessive|nettoyant|eponge|sac poubelle|vaisselle)\b", ["cleaning"]),
]

STOPWORDS = {
    "a", "au", "aux", "avec", "ce", "cette", "de", "des", "du", "dans", "en", "et", "je", "la",
    "le", "les", "l", "moi", "nous", "par", "pour", "que", "quoi", "tu", "un", "une", "veux",
    "voudrais", "propose", "proposes", "proposer", "idee", "idees", "quelque", "chose",
}

FEATURE_NAMES = [
    "role_match",
    "weighted_role_match",
    "label_match",
    "embedding_similarity",
    "query_name_similarity",
    "query_token_overlap",
    "is_food",
    "is_generic_bundle",
    "bundle_allowed",
    "generic_blocked",
    "has_options",
    "category_count",
    "multi_category",
    "local",
    "healthy",
    "need_confidence",
    "rank_prior",
    "focus_match",
    "anchor_match",
    "anchor_allowed",
    "anchor_blocked",
]

BUNDLE_ALLOWED_PATTERNS = [
    "panier",
    "offre",
    "surprise",
    "courses?",
    "semaine",
    "budget",
    "decouverte",
    "découverte",
]

BUDGET_CURRENCY_TERMS = ["chf", "fr", "frs", "franc", "francs", "franchs", "balle", "balles", ".-"]
BUDGET_TARGET_CUES = ["budget", "max", "maximum", "environ", "autour", "avec", "mettre", "depenser", "dépenser", "prix"]
BUDGET_ECONOMIC_CUES = ["pas cher", "pas chere", "pas cheres", "pas chers", "pas trop cher", "pas trop chere", "pas trop cheres", "pas trop chers", "economique", "économique", "raisonnable", "bon marche", "bon marché", "limiter budget"]
BUDGET_PREMIUM_CUES = ["tres cher", "très cher", "tres chere", "très chère", "tres cheres", "très chères", "tres chers", "très chers", "premium", "gourmand", "riche", "genereux", "généreux"]
BUDGET_HARD_NEGATIVE_CUES = ["personne", "personnes", "kilo", "kilos", "kg", "gramme", "grammes", "g", "litre", "litres", "heure", "heures"]

CONTEXT_NON_ANCHOR_TERMS = {
    "actuel",
    "actuelle",
    "adapte",
    "adaptee",
    "ami",
    "amis",
    "autour",
    "balle",
    "balles",
    "aujourd",
    "aujourdhui",
    "avec",
    "base",
    "bon",
    "bonne",
    "budget",
    "cher",
    "chere",
    "cheres",
    "chers",
    "chf",
    "chose",
    "concret",
    "concrete",
    "concretes",
    "deux",
    "disponible",
    "durable",
    "facile",
    "fatigue",
    "fatiguee",
    "frais",
    "fraiche",
    "fraiches",
    "fr",
    "franc",
    "francs",
    "franch",
    "franchs",
    "frs",
    "gourmand",
    "gourmande",
    "idee",
    "idees",
    "jour",
    "jours",
    "jeudi",
    "livraison",
    "lundi",
    "leger",
    "legere",
    "legeres",
    "local",
    "lourd",
    "lourde",
    "lourdes",
    "lourds",
    "mais",
    "mange",
    "manger",
    "manges",
    "matin",
    "mardi",
    "max",
    "maximum",
    "mercredi",
    "mettre",
    "midi",
    "moins",
    "premium",
    "option",
    "personne",
    "personnes",
    "partager",
    "plat",
    "plats",
    "possible",
    "proposition",
    "produit",
    "produits",
    "quelque",
    "rapide",
    "recevoir",
    "recois",
    "repa",
    "repas",
    "samedi",
    "dimanche",
    "simple",
    "soir",
    "soiree",
    "temps",
    "truc",
    "utile",
    "vendredi",
}

NEGATION_TEMPLATES = [
    "sans {term}",
    "san s {term}",
    "san {term}",
    "pas de {term}",
    "pas d {term}",
    "pas trop de {term}",
    "qui a pas de {term}",
    "qui n a pas de {term}",
    "je ne veux pas {term}",
    "ne veux pas {term}",
    "eviter {term}",
    "evite {term}",
    "evites {term}",
    "aucun {term}",
    "aucune {term}",
    "sans trop {term}",
]

NEGATION_TRIGGERS = [
    "sans",
    "san",
    "sauf",
    "pas",
    "eviter",
    "evite",
    "evites",
    "evitez",
    "aucun",
    "aucune",
]

NEGATION_CONNECTORS = [
    "a",
    "au",
    "aux",
    "avec",
    "d",
    "de",
    "des",
    "du",
    "la",
    "le",
    "les",
    "l",
    "trop",
    "tres",
    "vraiment",
]

NEGATIVE_QUALIFIER_ROLES = {
    "lourd": ["prepared_meal", "menu", "meat"],
    "lourde": ["prepared_meal", "menu", "meat"],
    "lourdes": ["prepared_meal", "menu", "meat"],
    "lourds": ["prepared_meal", "menu", "meat"],
    "sucre": ["sweet"],
    "sucree": ["sweet"],
    "sucres": ["sweet"],
    "sucrees": ["sweet"],
    "alcool": ["alcohol"],
}

ROLE_ALIAS_HINTS = {
    "aperitif": ["apero", "aperitif", "partager", "grignoter", "amis"],
    "alcohol": ["alcool", "biere", "vin", "cidre"],
    "basket": ["panier", "offre", "courses", "selection"],
    "breakfast": ["petit dejeuner", "dejeuner", "matin", "breakfast"],
    "cheese": ["fromage", "gruyere", "mozzarella", "raclette", "crottin"],
    "cleaning": ["menage", "nettoyage", "lessive", "nettoyant", "vaisselle"],
    "dairy": ["lait", "yaourt", "yogourt", "yoghourt", "brebis", "creme"],
    "dessert": ["dessert", "gateau", "sorbet", "glace", "chocolat", "gourmand"],
    "drink": ["boir", "boire", "boisson", "boissons", "jus", "sirop", "the", "cafe", "kefir"],
    "egg": ["oeuf", "oeufs"],
    "fish": ["poisson", "poissons", "perche", "perches", "brochet", "fera"],
    "fruit": ["fruit", "fruits", "pomme", "pommes", "poire", "poires", "ananas", "banane", "bananes", "fraise", "fraises"],
    "gift": ["cadeau", "offrir", "coffret"],
    "grain": ["cereale", "cereales", "muesli", "farine", "granola"],
    "hygiene": ["hygiene", "savon", "shampoing", "dentifrice", "soin"],
    "meat": ["viande", "boeuf", "poulet", "porc", "dinde", "lard", "jambon", "saucisse", "salami"],
    "prepared_meal": ["plat prepare", "menu", "pizza", "pannette", "pret"],
    "sauce": ["sauce", "ketchup", "moutarde", "mayonnaise"],
    "starch": ["riz", "pates", "pate", "pomme de terre", "patate", "feculent"],
    "sweet": ["sucre", "miel", "chocolat", "bonbon"],
    "vegetable": ["legume", "legumes", "salade", "tomate", "carotte", "asperge", "chou"],
}


def normalize(text: str) -> str:
    text = text.replace("œ", "oe").replace("Œ", "oe").lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^\w\s]", " ", text).strip()


def tokens(text: str) -> list[str]:
    out = []
    for token in normalize(text).split():
        if not token or token in STOPWORDS:
            continue
        out.append(token)
        if len(token) > 3 and token.endswith("s"):
            out.append(token[:-1])
    return sorted(set(out))


def compact(text: str) -> str:
    return re.sub(r"\s+", "", normalize(text))


def typo_variants(value: str) -> list[str]:
    """Small deterministic typo set used for robustness training and alias matching."""
    normalized = normalize(value)
    if not normalized:
        return []

    variants = {normalized}
    words = normalized.split()
    if len(words) > 1:
        variants.add(" ".join(words[:-1]) + " " + words[-1].rstrip("s"))
        variants.add("".join(words))

    for word in words:
        if len(word) < 4:
            continue
        index = min(2, len(word) - 2)
        variants.add(normalized.replace(word, word[:index] + word[index + 1 :], 1))
        variants.add(normalized.replace(word, word[:index] + word[index + 1] + word[index] + word[index + 2 :], 1))
        if word.endswith("e"):
            variants.add(normalized.replace(word, word[:-1], 1))
        if word.endswith("s"):
            variants.add(normalized.replace(word, word[:-1], 1))

    # Common French chat typo seen in client messages: "sans" split or missing final s.
    variants.add(normalized.replace("sans ", "san "))
    variants.add(normalized.replace("sans ", "san s "))
    return sorted(v for v in variants if v)


def add_alias(bucket: set[str], value: str) -> None:
    normalized = normalize(value)
    if not normalized or normalized in STOPWORDS:
        return
    if len(normalized) < 3:
        return
    bucket.add(normalized)
    for token in tokens(normalized):
        if len(token) >= 4 and token not in CONTEXT_NON_ANCHOR_TERMS:
            bucket.add(token)
    for variant in typo_variants(normalized):
        if len(variant) >= 4:
            bucket.add(variant)


def query_anchor_roles(query: str) -> set[str]:
    text = normalize(query)
    roles: set[str] = set()
    for pattern, pattern_roles in ROLE_PATTERNS:
        if re.search(pattern, text):
            roles.update(pattern_roles)

    if re.search(r"\bpomme\s+de\s+terre\b|\bpatate\b|\bpdt\b", text):
        roles.discard("fruit")
    if "drink" in roles and re.search(r"\b(jus|sirop|biere|vin|cidre|cafe|the|boir|boire|boisson|boissons)\b", text):
        roles.discard("fruit")

    return {role for role in roles if role in ANCHOR_POLICIES}


def profile_has_any_role(profile: dict[str, Any], roles: set[str]) -> bool:
    return bool(set(profile.get("roles", [])) & roles)


def anchor_allowed(profile: dict[str, Any], anchor_roles: set[str]) -> bool:
    if not anchor_roles:
        return True

    profile_roles = set(profile.get("roles", []))
    strict_roles = {
        role for role in anchor_roles
        if ANCHOR_POLICIES.get(role, {}).get("mode") == "strict_domain"
    }

    blocked_roles: set[str] = set()
    complement_roles: set[str] = set()
    for role in anchor_roles:
        policy = ANCHOR_POLICIES.get(role, {})
        blocked_roles.update(policy.get("blockedRoles", []))
        complement_roles.update(policy.get("complementRoles", []))

    if strict_roles:
        return bool(profile_roles & strict_roles) and not bool(profile_roles & blocked_roles)

    if profile_roles & anchor_roles:
        return not bool(profile_roles & blocked_roles)
    if complement_roles and profile_roles & complement_roles:
        return not bool(profile_roles & blocked_roles)
    return False


def sigmoid(x: float) -> float:
    if x < -50:
        return 0.0
    if x > 50:
        return 1.0
    return 1.0 / (1.0 + math.exp(-x))


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return default


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rows.append(json.loads(line))
    return rows


def load_catalog(path: Path) -> list[dict[str, Any]]:
    data = read_json(path, {})
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("products", "items", "data"):
            if isinstance(data.get(key), list):
                return data[key]
    return []


def catalog_signature(products: list[dict[str, Any]]) -> str:
    payload = [
        {
            "id": str(p.get("id", "")),
            "name": p.get("name", ""),
            "updated": p.get("_updatedAt", ""),
            "categories": p.get("categories", []),
        }
        for p in products
    ]
    return hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def metadata_text(product: dict[str, Any]) -> str:
    return " ".join(f"{m.get('key', '')} {m.get('value', '')}" for m in product.get("metadata", []) if isinstance(m, dict))


def metadata_value(product: dict[str, Any], key: str) -> Any:
    expected = normalize(key)
    for item in product.get("metadata", []) or []:
        if isinstance(item, dict) and normalize(str(item.get("key", ""))) == expected:
            return item.get("value")
    return None


def is_generic_bundle(product: dict[str, Any]) -> bool:
    text = normalize(f"{product.get('name', '')} {product.get('shortDescription', '')}")
    return bool(re.search(r"\b(offre|panier|courses?|decouverte|surprise|zelodarite)\b", text))


def is_food(product: dict[str, Any]) -> bool:
    cats = {str(c) for c in product.get("categories", [])}
    return bool(cats & FOOD_CATEGORIES) or not cats


def apply_manual_roles(profile: dict[str, Any], product: dict[str, Any], examples: list[dict[str, Any]]) -> None:
    product_id = str(product.get("id", ""))
    product_name = normalize(str(product.get("name", "")))
    for example in examples:
        wanted_id = str(example.get("productId", ""))
        wanted_name = normalize(str(example.get("name", "")))
        if wanted_id and wanted_id != product_id:
            continue
        if wanted_name and wanted_name not in product_name:
            continue
        if not wanted_id and not wanted_name:
            continue
        profile["roles"].update(example.get("roles", []))
        profile["labels"].update(example.get("labels", []))


def profile_product(product: dict[str, Any], role_examples: list[dict[str, Any]]) -> dict[str, Any]:
    profile = {
        "id": str(product.get("id", "")),
        "name": str(product.get("name", "")),
        "roles": set(),
        "labels": set(),
        "categoryIds": [str(c) for c in product.get("categories", [])],
        "categoryNames": [CATEGORY_NAME_BY_ID.get(str(c), "") for c in product.get("categories", []) if CATEGORY_NAME_BY_ID.get(str(c), "")],
        "tokens": tokens(f"{product.get('name', '')} {' '.join(product.get('tags', []) or [])}"),
        "isFood": is_food(product),
        "isGenericBundle": is_generic_bundle(product),
        "hasOptions": bool(product.get("availableOptions")),
        "rankPrior": 0.0,
        "labelPriors": defaultdict(float),
    }

    if profile["isGenericBundle"]:
        profile["roles"].add("basket")
        profile["labels"].update(["weekly_basket"])
    else:
        for cat in profile["categoryIds"]:
            profile["roles"].update(ROLE_BY_CATEGORY.get(cat, []))
        text = normalize(f"{product.get('name', '')} {' '.join(product.get('tags', []) or [])}")
        for pattern, roles in ROLE_PATTERNS:
            if re.search(pattern, text):
                profile["roles"].update(roles)
        if (
            "fruit" in profile["roles"]
            and "vegetable" in profile["roles"]
            and not re.search(r"\b(pomme de terre|patate|pdt|salade|legume|legumes|carotte|tomate|courgette|asperge|chou|rhubarbe|bette)\b", text)
        ):
            profile["roles"].discard("vegetable")
        if re.search(r"\b(pomme de terre|patate|pdt)\b", text):
            profile["roles"].discard("fruit")
        categories = set(profile["categoryIds"])
        if (
            "5f00d2cda5761c0007833362" in categories
            or ("5dcfdf0e6f4a93324a0a2b22" in categories and "5dcfddcb6f4a93324a0a2b1e" in categories)
            or re.search(r"\b(sandwich|panini|naan|bagnat|pate vaudois|pates vaudois|pate artisanal|chinois)\b", text)
        ):
            profile["roles"].update(["prepared_meal", "menu"])
        if "5dcfdf0e6f4a93324a0a2b22" in categories and "5dcfc1616f4a93324a0a2b1a" not in categories:
            profile["roles"].discard("cheese")
            profile["roles"].discard("dairy")

    apply_manual_roles(profile, product, role_examples)

    tags = {normalize(str(tag)) for tag in product.get("tags", []) or []}
    meta = normalize(metadata_text(product))
    if "bio" in tags or "bio" in meta:
        profile["labels"].add("healthy")
    if str(metadata_value(product, "Fresh")).lower() == "true":
        profile["labels"].add("healthy")
    try:
        if float(metadata_value(product, "Local") or 0) >= 4:
            profile["labels"].add("local")
    except Exception:
        pass
    if profile["roles"] & {"fruit", "vegetable", "grain", "protein", "starch"}:
        profile["labels"].add("balanced")
    if profile["roles"] & {"meat", "fish"}:
        profile["labels"].discard("vegetarian")

    profile["rankPrior"] = 0.25 if "local" in profile["labels"] else 0.0
    profile["rankPrior"] += 0.2 if "healthy" in profile["labels"] else 0.0
    profile["rankPrior"] -= 0.25 if profile["hasOptions"] else 0.0
    profile["rankPrior"] -= 0.3 if len(profile["categoryIds"]) > 4 and not profile["isGenericBundle"] else 0.0

    profile["roles"] = sorted(profile["roles"])
    profile["labels"] = sorted(profile["labels"])
    return profile


def apply_proposal_priors(
    profiles: list[dict[str, Any]],
    proposal_examples: list[dict[str, Any]],
) -> None:
    by_name = {normalize(profile["name"]): profile for profile in profiles}
    accepted = Counter()
    rejected = Counter()
    label_priors: dict[str, Counter[str]] = defaultdict(Counter)
    for example in proposal_examples:
        labels = [label for label in example.get("labels", []) if label in LABELS]
        for name in example.get("acceptedNames", []):
            key = normalize(str(name))
            if key in by_name:
                product_id = by_name[key]["id"]
                accepted[product_id] += 1
                for label in labels:
                    label_priors[product_id][label] += 1
        for name in example.get("rejectedNames", []):
            key = normalize(str(name))
            if key in by_name:
                rejected[by_name[key]["id"]] += 1

    for profile in profiles:
        profile["rankPrior"] += 0.75 * math.log1p(accepted[profile["id"]])
        profile["rankPrior"] -= 0.9 * math.log1p(rejected[profile["id"]])
        for label, count in label_priors[profile["id"]].items():
            profile["labelPriors"][label] += math.log1p(count)


def seed_query_examples() -> list[dict[str, Any]]:
    seeds = {
        "healthy,balanced": [
            "je veux manger plus sain", "quelque chose pour ma santé", "un panier équilibré",
            "des idées fraîches et légères", "je cherche des produits bons pour l'énergie",
            "propose moi quelque chose de sain", "des idées pour manger mieux",
            "un repas léger mais nourrissant", "quelque chose de frais pour aujourd'hui",
        ],
        "dinner,balanced": [
            "qu'est-ce que tu me proposes pour ce soir", "une idée pour le dîner",
            "un repas simple pour ce soir", "je ne sais pas quoi manger ce soir",
            "une assiette complète", "un repas équilibré pour ce soir",
            "tu me proposes quoi comme repas", "quelque chose de concret pour ce soir",
        ],
        "quick,dinner": [
            "un truc rapide pour ce soir", "je veux quelque chose de vite prêt",
            "une solution rapide", "pas trop de préparation", "un repas facile",
            "je n'ai pas le temps de cuisiner", "quelque chose de pratique",
        ],
        "vegetarian,balanced": [
            "une idée végétarienne", "un repas sans viande", "quelque chose sans poisson ni viande",
            "une option veggie", "un panier végétarien", "tu proposes quoi sans viande",
            "un plat végétarien équilibré",
        ],
        "aperitif,local": [
            "un apéro local", "quelque chose pour l'apéro", "des produits à partager",
            "un apéritif avec produits locaux", "je reçois des amis", "une planche apéro",
            "un apéro simple pour ce soir",
        ],
        "breakfast": [
            "quelque chose pour le petit déjeuner", "des idées pour le matin", "un bon déjeuner",
            "je veux préparer le petit déjeuner", "pain lait muesli pour le matin",
            "une base pour le matin", "un panier breakfast",
        ],
        "budget,weekly_basket": [
            "des idées pas trop chères", "un panier économique", "je veux limiter le budget",
            "quelque chose de simple et pas cher", "des bases utiles pour la semaine",
            "un panier budget", "des courses raisonnables",
        ],
        "dessert": [
            "une idée dessert", "quel dessert tu proposes", "quelque chose de gourmand",
            "un dessert simple", "une douceur pour ce soir", "un dessert avec fruit",
        ],
        "drink": [
            "une boisson sympa", "des boissons pour ce soir", "quelque chose à boire",
            "des jus pour accompagner", "une idée boisson", "que boire avec l'apéro",
        ],
        "kids,breakfast": [
            "des idées pour les enfants", "quelque chose que les enfants aiment",
            "un goûter pour les enfants", "un panier simple pour les petits",
        ],
        "cleaning": ["quelque chose pour le ménage", "des produits de nettoyage", "il me faut de la lessive"],
        "hygiene": ["des produits d'hygiène", "quelque chose pour la salle de bain", "savon et soin"],
        "gift": ["une idée cadeau", "quelque chose à offrir", "un petit cadeau gourmand"],
        "weekly_basket,discovery_open": [
            "je ne sais pas quoi commander cette semaine", "surprends moi avec un panier",
            "un panier pour la semaine", "une offre découverte",
        ],
        "discovery_open": [
            "qu'est-ce que tu me proposes aujourd'hui", "tu me proposes quoi aujourd'hui",
            "je ne sais pas quoi prendre", "donne moi des idées", "des suggestions",
        ],
    }
    rows: list[dict[str, Any]] = []
    for label_csv, texts in seeds.items():
        labels = label_csv.split(",")
        for text in texts:
            rows.append({"text": text, "labels": labels})
            rows.append({"text": f"André {text}", "labels": labels})
    return rows


def generated_constraint_examples() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    templates = [
        ("un repas sans {term}", ["healthy", "balanced"]),
        ("quelque chose sans {term}", ["healthy", "balanced"]),
        ("une idée qui a pas de {term}", ["healthy", "balanced"]),
        ("je veux éviter {term}", ["healthy", "balanced"]),
        ("un truc pas trop {term}", ["healthy", "balanced"]),
    ]
    role_labels = {
        "meat": ["vegetarian", "balanced"],
        "fish": ["vegetarian", "balanced"],
        "cheese": ["balanced"],
        "dairy": ["breakfast", "healthy"],
        "sweet": ["healthy", "balanced"],
        "drink": ["dinner", "balanced"],
        "prepared_meal": ["healthy", "balanced"],
        "cleaning": ["discovery_open"],
    }

    for role, aliases in ROLE_ALIAS_HINTS.items():
        labels = role_labels.get(role, ["discovery_open"])
        for alias in aliases[:4]:
            for template, fallback_labels in templates:
                rows.append({
                    "text": template.format(term=alias),
                    "labels": labels if labels != ["discovery_open"] else fallback_labels,
                })

    rows.extend([
        {"text": "un repas tranquille sans viande", "labels": ["vegetarian", "balanced", "dinner"]},
        {"text": "un repas tranquille san viande", "labels": ["vegetarian", "balanced", "dinner"]},
        {"text": "un repas tranquille san s viande", "labels": ["vegetarian", "balanced", "dinner"]},
        {"text": "un plat sans sucre", "labels": ["healthy", "dessert"]},
        {"text": "un plats sans sucre", "labels": ["healthy", "dessert"]},
        {"text": "un plats san s sucre", "labels": ["healthy", "dessert"]},
        {"text": "un plat qui a pas de sucre", "labels": ["healthy", "dessert"]},
        {"text": "un petit déjeuner sans lait", "labels": ["breakfast", "healthy"]},
        {"text": "une boisson sans alcool", "labels": ["drink"]},
        {"text": "un apéro sans alcool", "labels": ["aperitif", "drink"]},
        {"text": "quelque chose sans fromage", "labels": ["healthy", "balanced"]},
        {"text": "je veux éviter les plats lourds", "labels": ["healthy", "balanced"]},
        {"text": "une idée pas trop sucrée", "labels": ["healthy", "dessert"]},
        {"text": "un goûter sans chocolat", "labels": ["kids", "dessert"]},
        {"text": "produits maison sans lessive", "labels": ["cleaning", "hygiene"]},
    ])
    return rows


def generated_budget_examples() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    amounts = [25, 30, 40, 50, 75, 100, 120, 150]
    target_templates = [
        "quelque chose avec {amount} francs",
        "quelque chose avec {amount} franchs",
        "j ai un budget de {amount} fr",
        "je peux mettre {amount} CHF",
        "un repas autour de {amount} francs",
        "une idée pour environ {amount}.-",
        "un apéro avec max {amount} chf",
        "une idée avec du lard pour {amount} francs",
        "un repas avec du poisson budget {amount} fr",
        "quelque chose mais j ai {amount} francs disponible",
    ]
    for amount in amounts:
        for template in target_templates:
            text = template.format(amount=amount)
            labels = ["budget", "dinner"] if "repas" in text or "lard" in text or "poisson" in text else ["budget", "discovery_open"]
            rows.append({"text": text, "labels": labels})

    for text in [
        "des idées pas trop chères",
        "un panier économique",
        "je veux limiter mon budget",
        "quelque chose de simple et raisonnable",
        "un repas bon marché",
        "propose moi une option économique",
    ]:
        rows.append({"text": text, "labels": ["budget", "weekly_basket"]})

    for text in [
        "un repas très cher",
        "quelque chose de premium",
        "une idée gourmande et généreuse",
        "je veux un repas riche",
        "un truc gourmand mais simple",
    ]:
        rows.append({"text": text, "labels": ["dinner", "discovery_open"]})

    for text in [
        "repas pour 4 personnes",
        "livraison vendredi à 18h",
        "2 kilos de pommes",
        "3 produits pour ce soir",
        "vendredi 22 mai",
        "un repas pour deux amis",
        "une idée avec 3 produits",
    ]:
        rows.append({"text": text, "labels": ["discovery_open"]})

    return rows


def augment_query_examples(examples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    augmented: list[dict[str, Any]] = []
    for example in examples:
        text = str(example.get("text", "")).strip()
        labels = example.get("labels", [])
        if not text:
            continue
        augmented.append(example)
        variants = typo_variants(text)
        for variant in variants[:3]:
            if variant != normalize(text):
                augmented.append({"text": variant, "labels": labels})
    return augmented


def bundle_allowed(query: str, labels: list[str]) -> bool:
    text = normalize(query)
    if any(re.search(pattern, text) for pattern in BUNDLE_ALLOWED_PATTERNS):
        return True
    return "budget" in labels or "weekly_basket" in labels


def fit_tfidf(texts: list[str], max_features: int = 1800) -> tuple[dict[str, int], list[float], list[dict[int, float]]]:
    docs = [tokens(text) for text in texts]
    df = Counter()
    for doc in docs:
        df.update(set(doc))
    vocab_terms = [term for term, _ in df.most_common(max_features)]
    vocab = {term: index for index, term in enumerate(vocab_terms)}
    idf = [math.log((1 + len(docs)) / (1 + df[term])) + 1 for term in vocab_terms]
    vectors = []
    for doc in docs:
        counts = Counter(doc)
        vec: dict[int, float] = {}
        for term, count in counts.items():
            if term in vocab:
                idx = vocab[term]
                vec[idx] = count * idf[idx]
        vectors.append(vec)
    return vocab, idf, vectors


def train_logistic_sparse(
    vectors: list[dict[int, float]],
    targets: list[int],
    dim: int,
    epochs: int = 90,
    lr: float = 0.22,
    l2: float = 0.0008,
) -> tuple[list[float], float]:
    weights = [0.0] * dim
    bias = 0.0
    order = list(range(len(vectors)))
    rng = random.Random(17)
    for epoch in range(epochs):
        rng.shuffle(order)
        rate = lr / (1 + epoch * 0.018)
        for idx in order:
            vec = vectors[idx]
            y = targets[idx]
            raw = bias + sum(weights[i] * value for i, value in vec.items())
            error = sigmoid(raw) - y
            bias -= rate * error
            for i, value in vec.items():
                weights[i] -= rate * (error * value + l2 * weights[i])
    return weights, bias


def dense_from_sparse(vectors: list[dict[int, float]], dim: int) -> Any:
    if np is None:
        return None
    matrix = np.zeros((len(vectors), dim), dtype=float)
    for row_index, vector in enumerate(vectors):
        for col_index, value in vector.items():
            matrix[row_index, col_index] = value
    return matrix


def fit_binary_classifier(
    vectors: list[dict[int, float]],
    targets: list[int],
    dim: int,
) -> tuple[list[float], float, str]:
    if LogisticRegression is not None and np is not None and len(set(targets)) > 1:
        matrix = dense_from_sparse(vectors, dim)
        model = LogisticRegression(max_iter=1000, class_weight="balanced", solver="liblinear")
        model.fit(matrix, np.array(targets, dtype=int))
        return model.coef_[0].astype(float).tolist(), float(model.intercept_[0]), "sklearn"

    weights, bias = train_logistic_sparse(vectors, targets, dim)
    return weights, bias, "internal"


def cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    ln = math.sqrt(sum(a * a for a in left))
    rn = math.sqrt(sum(b * b for b in right))
    return dot / (ln * rn) if ln and rn else 0.0


def hashed_embedding(text: str, dim: int = 96) -> list[float]:
    vec = [0.0] * dim
    for token in tokens(text):
        digest = hashlib.sha1(token.encode()).digest()
        idx = int.from_bytes(digest[:4], "big") % dim
        sign = 1 if digest[4] % 2 == 0 else -1
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec] if norm else vec


def ollama_base_url() -> str:
    url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    return url.replace("host.docker.internal", "localhost").rstrip("/")


def ollama_embed(text: str, model: str) -> list[float] | None:
    payloads = [
        ("/api/embeddings", {"model": model, "prompt": text}),
        ("/api/embed", {"model": model, "input": text}),
    ]
    for suffix, payload in payloads:
        request = urllib.request.Request(
            f"{ollama_base_url()}{suffix}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = json.loads(response.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            continue
        vector = data.get("embedding") or (data.get("embeddings") or [None])[0]
        if isinstance(vector, list):
            return [float(v or 0) for v in vector]
    return None


def load_cached_product_embeddings() -> dict[str, list[float]]:
    data = read_json(CATALOG_EMBEDDINGS_PATH, [])
    output = {}
    if not isinstance(data, list):
        return output
    for item in data:
        if not isinstance(item, dict):
            continue
        product = item.get("product") or {}
        product_id = str(product.get("id") or item.get("productId") or item.get("id") or "")
        vector = item.get("embedding") or item.get("vector")
        if product_id and isinstance(vector, list):
            output[product_id] = [float(v or 0) for v in vector]
    return output


def build_embeddings(
    products: list[dict[str, Any]],
    queries: list[str],
    full: bool,
) -> tuple[dict[str, list[float]], dict[str, list[float]], str]:
    cached = read_json(DISCOVER_EMBEDDINGS_PATH, {})
    product_embeddings = {} if full else dict(cached.get("products", {}))
    query_embeddings = {} if full else dict(cached.get("queries", {}))
    mode = "hashed" if full else str(cached.get("mode") or "hashed")

    if not full:
        product_embeddings.update(load_cached_product_embeddings())

    missing_products = [p for p in products if str(p.get("id", "")) not in product_embeddings]
    missing_queries = [q for q in queries if q not in query_embeddings]

    model = os.environ.get("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text")
    if full or missing_queries:
        print(f"[discover-train] embedding mode: trying ollama model={model}")
    for index, product in enumerate(missing_products):
        if not full:
            break
        text = f"{product.get('name', '')}. {' '.join(product.get('tags', []) or [])}. {metadata_text(product)}"
        vector = ollama_embed(text, model)
        if vector:
            product_embeddings[str(product.get("id", ""))] = vector
            mode = "ollama"
        if index and index % 50 == 0:
            print(f"[discover-train] embedded products {index}/{len(missing_products)}")

    for query in missing_queries:
        vector = ollama_embed(query, model)
        if vector:
            query_embeddings[query] = vector
            mode = "ollama" if mode != "mixed" else "mixed"

    # If one side is missing or dimensions do not align, use deterministic hashed vectors for training.
    for product in products:
        product_id = str(product.get("id", ""))
        if product_id not in product_embeddings:
            product_embeddings[product_id] = hashed_embedding(f"{product.get('name', '')} {' '.join(product.get('tags', []) or [])}")
    for query in queries:
        if query not in query_embeddings:
            query_embeddings[query] = hashed_embedding(query)

    dims = {len(v) for v in product_embeddings.values() if v} | {len(v) for v in query_embeddings.values() if v}
    if len(dims) > 1:
        product_embeddings = {
            str(p.get("id", "")): hashed_embedding(f"{p.get('name', '')} {' '.join(p.get('tags', []) or [])}")
            for p in products
        }
        query_embeddings = {query: hashed_embedding(query) for query in queries}
        mode = "hashed"

    CACHE_DIR.mkdir(exist_ok=True)
    DISCOVER_EMBEDDINGS_PATH.write_text(
        json.dumps({"mode": mode, "products": product_embeddings, "queries": query_embeddings}, ensure_ascii=False),
        "utf-8",
    )
    return product_embeddings, query_embeddings, mode


def text_similarity(a: str, b: str) -> float:
    left = tokens(a)
    right = tokens(b)
    if not left or not right:
        return 0.0
    exact = len(set(left) & set(right)) / max(1, len(set(left)))
    return exact


def feature_vector(
    query: str,
    labels: list[str],
    profile: dict[str, Any],
    query_embedding: list[float],
    product_embedding: list[float],
    label_role_weights: dict[str, dict[str, float]],
) -> dict[str, float]:
    role_weights = Counter()
    for label in labels:
        role_weights.update(label_role_weights.get(label, {}))
    role_match = sum(1 for role in profile["roles"] if role_weights.get(role, 0) > 0.15)
    weighted_role_match = 0.0
    for label in labels:
        for role in profile["roles"]:
            weighted_role_match += label_role_weights.get(label, {}).get(role, 0.0)
    label_match = len(set(profile["labels"]) & set(labels))
    query_token_set = set(tokens(query))
    product_token_set = set(profile["tokens"])
    allowed = bundle_allowed(query, labels)
    anchor_roles = query_anchor_roles(query)
    anchor_match = profile_has_any_role(profile, anchor_roles)
    anchor_is_allowed = anchor_allowed(profile, anchor_roles)
    return {
        "role_match": float(role_match),
        "weighted_role_match": float(weighted_role_match),
        "label_match": float(label_match),
        "query_name_similarity": text_similarity(query, profile["name"]),
        "query_token_overlap": len(query_token_set & product_token_set) / max(1, len(query_token_set)),
        "is_food": 1.0 if profile["isFood"] else 0.0,
        "is_generic_bundle": 1.0 if profile["isGenericBundle"] else 0.0,
        "bundle_allowed": 1.0 if allowed else 0.0,
        "generic_blocked": 1.0 if profile["isGenericBundle"] and not allowed else 0.0,
        "has_options": 1.0 if profile["hasOptions"] else 0.0,
        "category_count": min(1.0, len(profile["categoryIds"]) / 8.0),
        "multi_category": 1.0 if len(profile["categoryIds"]) > 3 else 0.0,
        "local": 1.0 if "local" in profile["labels"] else 0.0,
        "healthy": 1.0 if "healthy" in profile["labels"] else 0.0,
        "need_confidence": 1.0,
        "rank_prior": float(profile["rankPrior"]),
        "embedding_similarity": cosine(query_embedding, product_embedding),
        "focus_match": 1.0 if anchor_is_allowed else 0.0,
        "anchor_match": 1.0 if anchor_match else 0.0,
        "anchor_allowed": 1.0 if anchor_is_allowed else 0.0,
        "anchor_blocked": 1.0 if anchor_roles and not anchor_is_allowed else 0.0,
    }


def target_for(
    labels: list[str],
    profile: dict[str, Any],
    query: str,
    accepted_ids: set[str],
    rejected_ids: set[str],
    label_role_weights: dict[str, dict[str, float]],
) -> int:
    if profile["id"] in accepted_ids:
        return 1
    if profile["id"] in rejected_ids:
        return 0
    if profile["isGenericBundle"] and not bundle_allowed(query, labels):
        return 0
    anchor_roles = query_anchor_roles(query)
    if anchor_roles and not anchor_allowed(profile, anchor_roles):
        return 0
    role_score = 0.0
    for label in labels:
        for role in profile["roles"]:
            role_score += label_role_weights.get(label, {}).get(role, 0.0)
    if role_score <= 0.15:
        return 0
    if not profile["isFood"] and not (set(labels) & {"cleaning", "hygiene", "gift"}):
        return 0
    return 1


def train_ranker(
    query_examples: list[dict[str, Any]],
    proposal_examples: list[dict[str, Any]],
    profiles: list[dict[str, Any]],
    product_by_name: dict[str, str],
    product_embeddings: dict[str, list[float]],
    query_embeddings: dict[str, list[float]],
    label_role_weights: dict[str, dict[str, float]],
) -> tuple[list[float], float, dict[str, Any]]:
    proposal_lookup: dict[str, tuple[set[str], set[str]]] = {}
    for example in proposal_examples:
        accepted = {product_by_name[normalize(name)] for name in example.get("acceptedNames", []) if normalize(name) in product_by_name}
        rejected = {product_by_name[normalize(name)] for name in example.get("rejectedNames", []) if normalize(name) in product_by_name}
        proposal_lookup[normalize(example.get("query", ""))] = (accepted, rejected)

    rows: list[dict[str, float]] = []
    targets: list[int] = []
    scanned = 0
    positives = 0
    negatives = 0

    for example in query_examples:
        query = example["text"]
        labels = example["labels"]
        accepted, rejected = proposal_lookup.get(normalize(query), (set(), set()))
        q_emb = query_embeddings.get(query) or hashed_embedding(query)
        hard_pool = []
        for profile in profiles:
            scanned += 1
            p_emb = product_embeddings.get(profile["id"]) or hashed_embedding(profile["name"])
            features = feature_vector(query, labels, profile, q_emb, p_emb, label_role_weights)
            target = target_for(labels, profile, query, accepted, rejected, label_role_weights)
            hardness = features["query_name_similarity"] + features["embedding_similarity"] + features["is_generic_bundle"]
            hard_pool.append((hardness, features, target))
        hard_pool.sort(key=lambda item: item[0], reverse=True)
        for hardness, features, target in hard_pool:
            if target:
                rows.append(features)
                targets.append(1)
                positives += 1
            elif hardness >= 0.18 or features["generic_blocked"] or random.random() < 0.025:
                rows.append(features)
                targets.append(0)
                negatives += 1

    trainer = "internal"
    if LogisticRegression is not None and np is not None and len(set(targets)) > 1:
        matrix = np.array([[row.get(name, 0.0) for name in FEATURE_NAMES] for row in rows], dtype=float)
        model = LogisticRegression(max_iter=1000, class_weight="balanced", solver="liblinear")
        model.fit(matrix, np.array(targets, dtype=int))
        weights = model.coef_[0].astype(float).tolist()
        bias = float(model.intercept_[0])
        trainer = "sklearn"
    else:
        rng = random.Random(19)
        order = list(range(len(rows)))
        weights = [0.0] * len(FEATURE_NAMES)
        bias = 0.0
        for epoch in range(110):
            rng.shuffle(order)
            rate = 0.18 / (1 + epoch * 0.02)
            for idx in order:
                row = rows[idx]
                y = targets[idx]
                raw = bias + sum(weights[i] * row.get(name, 0.0) for i, name in enumerate(FEATURE_NAMES))
                error = sigmoid(raw) - y
                bias -= rate * error
                for i, name in enumerate(FEATURE_NAMES):
                    weights[i] -= rate * (error * row.get(name, 0.0) + 0.0008 * weights[i])

    correct = 0
    for row, y in zip(rows, targets):
        raw = bias + sum(weights[i] * row.get(name, 0.0) for i, name in enumerate(FEATURE_NAMES))
        pred = 1 if sigmoid(raw) >= 0.5 else 0
        correct += 1 if pred == y else 0
    metrics = {
        "pairsScanned": scanned,
        "trainingPairs": len(rows),
        "positivePairs": positives,
        "negativePairs": negatives,
        "trainingAccuracy": round(correct / max(1, len(rows)), 4),
        "trainer": trainer,
    }
    return weights, bias, metrics


def build_query_examples(manual: list[dict[str, Any]]) -> list[dict[str, Any]]:
    examples = augment_query_examples(manual + seed_query_examples() + generated_constraint_examples())
    seen = set()
    unique = []
    for item in examples:
        text = str(item.get("text", "")).strip()
        labels = [label for label in item.get("labels", []) if label in LABELS]
        if not text or not labels:
            continue
        key = (normalize(text), tuple(labels))
        if key in seen:
            continue
        seen.add(key)
        unique.append({"text": text, "labels": labels})
    return unique


def collect_label_universe(*datasets: list[dict[str, Any]]) -> list[str]:
    labels = set(BASE_LABELS)
    for dataset in datasets:
        for item in dataset:
            for label in item.get("labels", []) or []:
                label = str(label).strip()
                if label:
                    labels.add(label)
    return sorted(labels)


def collect_role_universe(
    role_examples: list[dict[str, Any]],
    ranking_examples: list[dict[str, Any]],
    profiles: list[dict[str, Any]],
    label_role_weights: dict[str, dict[str, float]],
) -> list[str]:
    roles = set()
    for values in ROLE_BY_CATEGORY.values():
        roles.update(values)
    for values in NEED_ROLE_PRIORITY.values():
        roles.update(values)
    for _, values in ROLE_PATTERNS:
        roles.update(values)
    for role, policy in ANCHOR_POLICIES.items():
        roles.add(role)
        roles.update(policy.get("complementRoles", []) or [])
        roles.update(policy.get("blockedRoles", []) or [])
    for example in role_examples:
        roles.update(str(role).strip() for role in example.get("roles", []) or [] if str(role).strip())
    for example in ranking_examples:
        roles.update(str(role).strip() for role in example.get("acceptedRoles", []) or [] if str(role).strip())
        roles.update(str(role).strip() for role in example.get("rejectedRoles", []) or [] if str(role).strip())
    for profile in profiles:
        roles.update(str(role).strip() for role in profile.get("roles", []) or [] if str(role).strip())
    for weights in label_role_weights.values():
        roles.update(str(role).strip() for role in weights.keys() if str(role).strip())
    return sorted(roles)


def build_role_alias_index(roles: list[str], profiles: list[dict[str, Any]]) -> dict[str, list[str]]:
    index: dict[str, set[str]] = {role: set() for role in roles}

    for role in roles:
        add_alias(index[role], role.replace("_", " "))
        for alias in ROLE_ALIAS_HINTS.get(role, []):
            add_alias(index[role], alias)

    for pattern, pattern_roles in ROLE_PATTERNS:
        raw_terms = re.sub(r"\\b|\(|\)|\?|\\s\+|\[|\]", "", pattern)
        for term in re.split(r"\|", raw_terms):
            term = term.strip("\\ ")
            if not term or len(term) < 3:
                continue
            for role in pattern_roles:
                if role in index:
                    add_alias(index[role], term)

    return {role: sorted(values)[:220] for role, values in index.items() if values}


def build_product_alias_index(profiles: list[dict[str, Any]]) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for profile in profiles:
        aliases: set[str] = set()
        add_alias(aliases, profile["name"])
        for token in profile.get("tokens", []):
            if len(token) >= 4 and token not in CONTEXT_NON_ANCHOR_TERMS:
                add_alias(aliases, token)
        index[profile["id"]] = sorted(aliases)[:80]
    return index


def build_focus_policy(
    profiles: list[dict[str, Any]],
    planner_roles: list[str],
) -> dict[str, Any]:
    product_alias_index = build_product_alias_index(profiles)
    role_alias_index = build_role_alias_index(planner_roles, profiles)
    catalog_common_terms = Counter()
    for aliases in product_alias_index.values():
        catalog_common_terms.update(alias for alias in aliases if " " not in alias)
    noisy_catalog_terms = {
        term for term, count in catalog_common_terms.items()
        if count >= 8 and term not in {"pomme", "pommes", "fruit", "fruits", "boisson", "boissons"}
    }

    return {
        "schemaVersion": 1,
        "nonAnchorTerms": sorted(CONTEXT_NON_ANCHOR_TERMS | noisy_catalog_terms),
        "roleAliasIndex": role_alias_index,
        "productAliasIndex": product_alias_index,
        "negationTemplates": NEGATION_TEMPLATES,
        "negationTriggers": NEGATION_TRIGGERS,
        "negationConnectors": NEGATION_CONNECTORS,
        "negativeQualifierRoles": NEGATIVE_QUALIFIER_ROLES,
        "typoTolerance": {
            "tokenMinSimilarity": 0.78,
            "phraseMinSimilarity": 0.82,
            "compactMinLength": 5,
        },
    }


def normalize_role_weights(weights: dict[str, Counter[str]]) -> dict[str, dict[str, float]]:
    output: dict[str, dict[str, float]] = {}
    for label, counter in weights.items():
        if label not in LABELS:
            continue
        max_abs = max((abs(value) for value in counter.values()), default=1.0)
        output[label] = {
            role: round(value / max_abs, 4)
            for role, value in sorted(counter.items())
            if abs(value) >= 0.05
        }
    return output


def build_label_role_weights(
    profiles: list[dict[str, Any]],
    proposal_examples: list[dict[str, Any]],
    ranking_examples: list[dict[str, Any]],
    product_by_name: dict[str, str],
) -> dict[str, dict[str, float]]:
    by_id = {profile["id"]: profile for profile in profiles}
    weights: dict[str, Counter[str]] = defaultdict(Counter)

    for example in ranking_examples:
        labels = [label for label in example.get("labels", []) if label in LABELS]
        for label in labels:
            for role in example.get("acceptedRoles", []) or []:
                weights[label][role] += 2.5
            for role in example.get("rejectedRoles", []) or []:
                weights[label][role] -= 4.0

    for example in proposal_examples:
        labels = [label for label in example.get("labels", []) if label in LABELS]
        accepted_ids = [
            product_by_name[normalize(name)]
            for name in example.get("acceptedNames", [])
            if normalize(name) in product_by_name
        ]
        rejected_ids = [
            product_by_name[normalize(name)]
            for name in example.get("rejectedNames", [])
            if normalize(name) in product_by_name
        ]
        for label in labels:
            for product_id in accepted_ids:
                for role in by_id.get(product_id, {}).get("roles", []):
                    weights[label][role] += 2.0
            for product_id in rejected_ids:
                for role in by_id.get(product_id, {}).get("roles", []):
                    weights[label][role] -= 3.0

    return normalize_role_weights(weights)


def slug(value: str) -> str:
    normalized = normalize(value)
    normalized = re.sub(r"\s+", "_", normalized).strip("_")
    return normalized or "proposal"


def build_proposal_blueprints(
    proposal_examples: list[dict[str, Any]],
    product_by_name: dict[str, str],
) -> list[dict[str, Any]]:
    blueprints = []
    seen = set()
    for example in proposal_examples:
        title = str(example.get("title") or example.get("query") or "Idée catalogue").strip()
        labels = [label for label in example.get("labels", []) if label in LABELS]
        product_ids = [
            product_by_name[normalize(name)]
            for name in example.get("acceptedNames", [])
            if normalize(name) in product_by_name
        ]
        rejected_ids = [
            product_by_name[normalize(name)]
            for name in example.get("rejectedNames", [])
            if normalize(name) in product_by_name
        ]
        if not labels:
            continue
        key = f"{slug(title)}|{','.join(labels)}"
        if key in seen:
            continue
        seen.add(key)
        blueprints.append(
            {
                "id": slug(title),
                "title": title,
                "why": str(example.get("why") or "proposition validée à partir du catalogue"),
                "labels": labels,
                "productIds": product_ids,
                "rejectedProductIds": rejected_ids,
            }
        )
    return blueprints


def build_budget_policy(
    budget_examples: list[dict[str, Any]],
    hard_negatives: list[dict[str, Any]],
) -> dict[str, Any]:
    target_examples = [
        row for row in budget_examples
        if re.search(r"\d", str(row.get("text", ""))) and any(term in normalize(row.get("text", "")) for term in ["fr", "chf", "budget", ".-"])
    ]
    economic_examples = [
        row for row in budget_examples
        if any(cue in normalize(row.get("text", "")) for cue in ["pas cher", "economique", "raisonnable", "bon marche"])
    ]
    premium_examples = [
        row for row in budget_examples
        if any(cue in normalize(row.get("text", "")) for cue in ["tres cher", "premium", "gourmand", "riche"])
    ]
    hard_negative_examples = hard_negatives or [
        {"text": "repas pour 4 personnes"},
        {"text": "livraison vendredi à 18h"},
        {"text": "2 kilos de pommes"},
        {"text": "3 produits pour ce soir"},
    ]

    return {
        "schemaVersion": 1,
        "currencyTerms": BUDGET_CURRENCY_TERMS,
        "targetCues": BUDGET_TARGET_CUES,
        "economicCues": BUDGET_ECONOMIC_CUES,
        "premiumCues": BUDGET_PREMIUM_CUES,
        "hardNegativeCues": BUDGET_HARD_NEGATIVE_CUES,
        "toleranceRatio": 0.15,
        "toleranceMinCHF": 5,
        "metrics": {
            "targetExamples": len(target_examples),
            "economicExamples": len(economic_examples),
            "premiumExamples": len(premium_examples),
            "hardNegativeExamples": len(hard_negative_examples),
            "generatedExamples": len(generated_budget_examples()),
        },
    }


def read_response_styles(styles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for style in styles:
        labels = [label for label in style.get("labels", []) if label in LABELS]
        if not labels:
            continue
        output.append(
            {
                "id": str(style.get("id") or slug(",".join(labels))),
                "labels": labels,
                "intro": str(style.get("intro") or "Je peux te proposer quelques idées concrètes :"),
                "cta": str(style.get("cta") or "Si une idée te plaît, écris les produits que tu veux ajouter."),
                "lowConfidence": str(
                    style.get("lowConfidence")
                    or "Je peux t’aider, mais il me manque un peu de contexte pour proposer quelque chose de vraiment utile."
                ),
            }
        )
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Rebuild embeddings and scan the full catalog from scratch.")
    parser.add_argument("--catalog", default=str(CATALOG_PATH))
    args = parser.parse_args()

    started = time.time()
    products = load_catalog(Path(args.catalog))
    if not products:
        raise SystemExit(f"No catalog products found at {args.catalog}")

    manual_queries = read_jsonl(TRAINING_DIR / "query_intents.jsonl")
    constraint_examples = read_jsonl(TRAINING_DIR / "constraint_examples.jsonl")
    typo_eval_examples = read_jsonl(TRAINING_DIR / "typo_eval.jsonl")
    golden_eval_examples = read_jsonl(TRAINING_DIR / "golden_discover_eval.jsonl")
    budget_examples = read_jsonl(TRAINING_DIR / "budget_examples.jsonl")
    budget_hard_negatives = read_jsonl(TRAINING_DIR / "budget_hard_negatives.jsonl")
    role_examples = read_jsonl(TRAINING_DIR / "product_roles.jsonl")
    ranking_examples = read_jsonl(TRAINING_DIR / "ranking_examples.jsonl") + read_jsonl(TRAINING_DIR / "proposal_ranking.jsonl")
    proposal_examples = read_jsonl(TRAINING_DIR / "proposal_examples.jsonl")
    response_style_rows = read_jsonl(TRAINING_DIR / "response_styles.jsonl")
    global LABELS
    LABELS = collect_label_universe(
        manual_queries,
        constraint_examples,
        typo_eval_examples,
        golden_eval_examples,
        budget_examples,
        budget_hard_negatives,
        ranking_examples,
        proposal_examples,
        response_style_rows,
    )
    response_styles = read_response_styles(response_style_rows)
    budget_training_examples = budget_examples + budget_hard_negatives + generated_budget_examples()
    query_examples = build_query_examples(
        manual_queries + constraint_examples + typo_eval_examples + golden_eval_examples + budget_training_examples
    )

    print(f"[discover-train] catalog products: {len(products)}")
    print(f"[discover-train] query examples: {len(query_examples)}")
    print(f"[discover-train] product role examples: {len(role_examples)}")
    print(f"[discover-train] proposal examples: {len(proposal_examples)}")

    profiles = [profile_product(product, role_examples) for product in products if product.get("id") and product.get("name")]
    apply_proposal_priors(profiles, proposal_examples)
    product_by_name = {normalize(profile["name"]): profile["id"] for profile in profiles}
    label_role_weights = build_label_role_weights(profiles, proposal_examples, ranking_examples, product_by_name)
    proposal_blueprints = build_proposal_blueprints(proposal_examples, product_by_name)
    planner_vocabulary = {
        "needs": LABELS,
        "roles": collect_role_universe(role_examples, ranking_examples, profiles, label_role_weights),
    }
    focus_policy = build_focus_policy(profiles, planner_vocabulary["roles"])
    budget_policy = build_budget_policy(budget_examples + generated_budget_examples(), budget_hard_negatives)

    product_embeddings, query_embeddings, embedding_mode = build_embeddings(
        products,
        [example["text"] for example in query_examples],
        args.full,
    )

    vocab, idf, vectors = fit_tfidf([example["text"] for example in query_examples])
    intent_weights: dict[str, list[float]] = {}
    intent_bias: dict[str, float] = {}
    thresholds: dict[str, float] = {}
    intent_trainer = "internal"
    for label in LABELS:
        targets = [1 if label in example["labels"] else 0 for example in query_examples]
        weights, bias, trainer = fit_binary_classifier(vectors, targets, len(vocab))
        if trainer == "sklearn":
            intent_trainer = "sklearn"
        intent_weights[label] = [round(value, 6) for value in weights]
        intent_bias[label] = round(bias, 6)
        thresholds[label] = 0.33 if sum(targets) >= 4 else 0.42

    ranker_weights, ranker_bias, ranker_metrics = train_ranker(
        query_examples,
        proposal_examples,
        profiles,
        product_by_name,
        product_embeddings,
        query_embeddings,
        label_role_weights,
    )

    product_profiles = {
        profile["id"]: {
            **profile,
            "roles": sorted(profile["roles"]),
            "labels": sorted(profile["labels"]),
            "rankPrior": round(float(profile["rankPrior"]), 4),
            "labelPriors": {label: round(float(value), 4) for label, value in profile["labelPriors"].items()},
        }
        for profile in profiles
    }
    generic_ids = [profile["id"] for profile in profiles if profile["isGenericBundle"]]

    artifact = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "queryIntents": manual_queries,
        "productRoles": role_examples,
        "rankingExamples": ranking_examples,
        "model": {
            "schemaVersion": 1,
            "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "trainingMode": "full" if args.full else "cached",
            "catalog": {
                "count": len(products),
                "source": str(Path(args.catalog)),
                "signature": catalog_signature(products),
            },
            "intentClassifier": {
                "labels": LABELS,
                "vocabulary": vocab,
                "idf": [round(value, 6) for value in idf],
                "weights": intent_weights,
                "bias": intent_bias,
                "thresholds": thresholds,
            },
            "productRanker": {
                "featureNames": FEATURE_NAMES,
                "weights": [round(value, 6) for value in ranker_weights],
                "bias": round(ranker_bias, 6),
            },
            "productProfiles": product_profiles,
            "labelRoleWeights": label_role_weights,
            "proposalBlueprints": proposal_blueprints,
            "responseStyles": response_styles,
            "genericBundleProductIds": generic_ids,
            "bundleAllowedPatterns": BUNDLE_ALLOWED_PATTERNS,
            "plannerVocabulary": planner_vocabulary,
            "anchorPolicies": ANCHOR_POLICIES,
            "focusPolicy": focus_policy,
            "budgetPolicy": budget_policy,
            "evaluationReport": {
                "constraintExamples": len(constraint_examples),
                "typoEvalExamples": len(typo_eval_examples),
                "goldenEvalExamples": len(golden_eval_examples),
                "budgetExamples": len(budget_examples),
                "budgetHardNegatives": len(budget_hard_negatives),
                "syntheticQueryExamples": len(query_examples) - len(manual_queries),
                "focusPolicy": {
                    "roleAliases": sum(len(values) for values in focus_policy["roleAliasIndex"].values()),
                    "productAliases": sum(len(values) for values in focus_policy["productAliasIndex"].values()),
                    "nonAnchorTerms": len(focus_policy["nonAnchorTerms"]),
                },
            },
            "metrics": {
                "embeddingMode": embedding_mode,
                "durationSeconds": round(time.time() - started, 2),
                "queryExamples": len(query_examples),
                "catalogProducts": len(products),
                "genericBundleProducts": len(generic_ids),
                "proposalBlueprints": len(proposal_blueprints),
                "responseStyles": len(response_styles),
                "intentTrainer": intent_trainer,
                "ranker": ranker_metrics,
                "budgetMetrics": budget_policy["metrics"],
                "sklearnAvailable": bool(LogisticRegression and OneVsRestClassifier and np is not None),
            },
        },
    }

    CACHE_DIR.mkdir(exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), "utf-8")
    print(f"[discover-train] wrote {OUTPUT_PATH}")
    print(json.dumps(artifact["model"]["metrics"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
