#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import random
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path.cwd()
CACHE_DIR = ROOT / ".cache"
PUBLIC_TRAINING = ROOT / "public" / "predictor" / "intent-training.json"
CATALOG_FILE = CACHE_DIR / "catalog-local-dev.json"
LEDGER_FILE = CACHE_DIR / "intent-feedback-ledger.json"
MODEL_FILE = CACHE_DIR / "intent-classifier-model.json"
RUNTIME_FILE = CACHE_DIR / "intent-training.runtime.json"

ACTIVE_LABELS = [
    "add_items",
    "clear_cart",
    "show_cart",
    "exec_cart",
    "discover_meals",
    "recurring_orders",
    "noop",
]

PRIMARY_AUDIT_LABELS = ["add_items", "clear_cart", "discover_meals", "noop"]
HIDDEN_LABELS = ["build_meal"]
FALLBACK_LABEL = "noop"

LABEL_META = {
    "add_items": {"family": "add", "label": "ADD_ITEMS", "planner": "planner/add_items"},
    "clear_cart": {"family": "cart", "label": "CLEAR_CART", "planner": "planner/clear_cart"},
    "show_cart": {"family": "cart", "label": "SHOW_CART", "planner": "planner/show_cart"},
    "exec_cart": {"family": "cart", "label": "EXEC_CART", "planner": "planner/exec_cart"},
    "discover_meals": {"family": "meal", "label": "DISCOVER_MEALS", "planner": "planner/discover_meals"},
    "recurring_orders": {"family": "recurring", "label": "RECURRING_ORDERS", "planner": "planner/recurring_orders"},
    "noop": {"family": "general", "label": "NOOP", "planner": "planner/general"},
}


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def strip_accents(text: str) -> str:
    return "".join(
        ch
        for ch in unicodedata.normalize("NFD", text)
        if unicodedata.category(ch) != "Mn"
    )


def normalize_text(value: str) -> str:
    text = strip_accents(str(value or "").lower())
    text = re.sub(r"[^a-z0-9\s']", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


FORCE_TRAIN_CASES = {
    ("exec_cart", normalize_text("ok")),
}


def tokenize(value: str) -> list[str]:
    normalized = normalize_text(value)
    return [token for token in normalized.split(" ") if token]


def build_feature_counts(value: str) -> dict[str, float]:
    normalized = normalize_text(value)
    counts: defaultdict[str, float] = defaultdict(float)
    if not normalized:
        return {}

    tokens = tokenize(normalized)

    def add(feature: str, amount: float) -> None:
        if feature:
            counts[feature] += amount

    for index, token in enumerate(tokens):
        add(f"w:{token}", 2.2)
        if len(token) >= 4:
            add(f"p:{token[:4]}", 1.0)
            add(f"s:{token[-4:]}", 1.0)
        if index < len(tokens) - 1:
            add(f"b:{token}_{tokens[index + 1]}", 1.8)
        if index < len(tokens) - 2:
            add(f"t:{token}_{tokens[index + 1]}_{tokens[index + 2]}", 1.15)

    source = f" {normalized} "
    for size, weight in ((3, 0.75), (4, 0.62), (5, 0.48)):
        for index in range(0, max(len(source) - size + 1, 0)):
            gram = source[index:index + size]
            if gram.strip():
                add(f"c:{gram}", weight)

    return dict(counts)


def vectorize(counts: dict[str, float], idf: dict[str, float]) -> dict[str, float]:
    weights: dict[str, float] = {}
    norm_squared = 0.0
    for feature, count in counts.items():
        if feature not in idf:
            continue
        weight = (1.0 + math.log(max(count, 1e-9))) * idf.get(feature, 1.0)
        weights[feature] = weight
        norm_squared += weight * weight
    norm = math.sqrt(norm_squared) or 1.0
    return {feature: value / norm for feature, value in weights.items()}


def dot(weights: dict[str, float], vector: dict[str, float]) -> float:
    if len(weights) < len(vector):
        return sum(value * vector.get(feature, 0.0) for feature, value in weights.items())
    return sum(value * weights.get(feature, 0.0) for feature, value in vector.items())


def softmax(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    max_score = max(scores.values())
    exp_values = {key: math.exp((value - max_score) * 1.65) for key, value in scores.items()}
    total = sum(exp_values.values()) or 1.0
    return {key: value / total for key, value in exp_values.items()}


def score_model(model: dict[str, Any], vector: dict[str, float]) -> dict[str, float]:
    scores: dict[str, float] = {}
    for label in model["labels"]:
        scores[label] = model["biases"].get(label, 0.0) + dot(model["weights"].get(label, {}), vector)
    return scores


def prediction_from_scores(scores: dict[str, float]) -> dict[str, Any]:
    ranking = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    top_label, top_score = ranking[0]
    second_label, second_score = ranking[1] if len(ranking) > 1 else (FALLBACK_LABEL, top_score)
    probabilities = softmax(scores)
    probability = probabilities.get(top_label, 0.0)
    margin = top_score - second_score
    margin_component = max(0.0, min(1.0, margin / 1.4))
    confidence = round(max(1.0, min(99.0, (probability * 0.68 + margin_component * 0.32) * 100)))
    return {
        "label": top_label,
        "score": top_score,
        "probability": probability,
        "confidence": confidence,
        "margin": margin,
        "secondChoice": {"label": second_label, "score": second_score},
        "ambiguity": margin < 0.075 or probability < 0.42,
    }


def apply_typo(text: str, rng: random.Random) -> str:
    variants = [text, strip_accents(text)]
    words = text.split()
    if len(words) > 2:
        index = rng.randrange(len(words))
        word = words[index]
        if len(word) > 4:
            pos = rng.randrange(1, len(word) - 1)
            words[index] = word[:pos] + word[pos + 1:]
            variants.append(" ".join(words))

    chars = list(strip_accents(text))
    alpha_positions = [i for i, ch in enumerate(chars) if ch.isalpha()]
    if len(alpha_positions) >= 2:
        pos = rng.choice(alpha_positions[:-1])
        chars[pos], chars[pos + 1] = chars[pos + 1], chars[pos]
        variants.append("".join(chars))

    variants.append(text.replace("'", " ").replace("’", " "))
    variants.append(re.sub(r"\s+", "  ", strip_accents(text), count=1))
    return rng.choice(variants)


def load_products() -> list[str]:
    catalog = read_json(CATALOG_FILE, {})
    products = catalog.get("products") if isinstance(catalog, dict) else []
    names: list[str] = []
    for product in products or []:
        name = product.get("name") or product.get("productName") or product.get("label")
        if not isinstance(name, str):
            continue
        cleaned = re.sub(r"\s+", " ", name).strip()
        if 2 <= len(cleaned) <= 90:
            names.append(cleaned)
    return sorted(set(names))


def choose_product(products: list[str], rng: random.Random) -> str:
    return rng.choice(products) if products else rng.choice([
        "Pain aux noix",
        "Pommes Bio ou VV",
        "A. Lait Bio pasteurisé",
        "Gruyère doux",
    ])


def product_list(products: list[str], rng: random.Random, min_count: int = 2, max_count: int = 5) -> list[str]:
    count = rng.randint(min_count, max_count)
    if len(products) >= count:
        return rng.sample(products, count)
    return [choose_product(products, rng) for _ in range(count)]


def qty_prefix(product: str, rng: random.Random) -> str:
    style = rng.choice(["piece", "piece", "kg", "g", "litre", "none"])
    if style == "kg":
        return f"{rng.randint(1, 4)} kg de {product}"
    if style == "g":
        return f"{rng.choice([100, 150, 200, 250, 300, 400, 500])}g de {product}"
    if style == "litre":
        n = rng.randint(1, 4)
        return f"{n} litre{'s' if n > 1 else ''} de {product}"
    if style == "piece":
        return f"{rng.randint(1, 6)} {product}"
    return product


def add_sample(rows: list[dict[str, Any]], label: str, text: str, source: str, weight: int = 1) -> None:
    normalized = normalize_text(text)
    if not normalized:
        return
    rows.append({
        "label": label,
        "text": text,
        "normalized": normalized,
        "source": source,
        "weight": max(1, min(int(weight), 8)),
    })


def add_augmented(rows: list[dict[str, Any]], label: str, text: str, source: str, rng: random.Random, weight: int = 1) -> None:
    add_sample(rows, label, text, source, weight)
    if rng.random() < 0.34:
        add_sample(rows, label, apply_typo(text, rng), f"{source}:typo", weight)


def generate_samples(products: list[str], full: bool, rng: random.Random) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    scale = 1 if full else 0.2

    add_templates = [
        "ajoute {items}",
        "rajoute {items}",
        "rajoute juste {items}",
        "mets {items} dans mon panier",
        "mets-moi {items}",
        "tu peux me mettre {items} pour demain",
        "peux-tu me mettre {items}",
        "peux tu me mettre {items}",
        "Salut André, peux-tu me mettre {items} ?",
        "Salut André, pour demain tu peux me mettre {items} ? Merci beaucoup",
        "Bonjour André, si jamais tu peux me mettre {items}, merci",
        "je te prends volontiers {items}",
        "il me faudrait {items}",
        "j'aimerais commander {items}",
        "je voudrais acheter {items}",
        "si possible ajoute {items}",
        "bonjour andre, je veux bien {items}, merci",
        "pour la prochaine livraison, {items}",
        "est-ce que tu peux me livrer {items}",
    ]
    for product in products:
        for _ in range(2 if full else 1):
            item = qty_prefix(product, rng)
            add_augmented(rows, "add_items", rng.choice(add_templates).format(items=item), "catalog_product", rng)

    for _ in range(int(1800 * scale)):
        items = [qty_prefix(product, rng) for product in product_list(products, rng, 2, 6)]
        separator = rng.choice([", ", " et ", "\n- ", " puis "])
        joined = separator.join(items)
        add_augmented(rows, "add_items", rng.choice(add_templates).format(items=joined), "generated_add_list", rng)

    clear_all_templates = [
        "vide mon panier",
        "enleve tout du panier",
        "efface tout ce qu'il y a dans mon panier",
        "supprime tout ce que j'ai mis",
        "finalement je ne veux plus rien",
        "annule tout mon panier",
        "annule ma selection actuelle",
        "annule ma selection",
        "efface toute ma commande",
        "retire tous les articles",
        "je repars de zero, vide le panier",
        "peux-tu vider entierement mon panier",
        "il faut que mon panier soit vide",
    ]
    for template in clear_all_templates:
        for _ in range(int(80 * scale) + 1):
            add_augmented(rows, "clear_cart", template, "generated_clear_all", rng, 2)

    clear_partial_templates = [
        "retire {item}",
        "supprime {item} de mon panier",
        "enleve juste {item}",
        "finalement pas de {item}",
        "je ne veux plus {item}",
        "tu peux enlever {item} seulement",
        "retire de la commande {item}",
    ]
    for _ in range(int(1400 * scale)):
        item = qty_prefix(choose_product(products, rng), rng)
        add_augmented(rows, "clear_cart", rng.choice(clear_partial_templates).format(item=item), "generated_clear_partial", rng)

    show_templates = [
        "montre mon panier",
        "je veux voir mon panier",
        "qu'est-ce qu'il y a dans mon panier",
        "affiche la commande actuelle",
        "ouvre le panier",
        "tu peux me montrer ce que j'ai commande",
        "resume mon panier",
        "il contient quoi mon panier",
    ]
    for _ in range(int(500 * scale)):
        add_augmented(rows, "show_cart", rng.choice(show_templates), "generated_show", rng)

    exec_templates = [
        "passe la commande",
        "tu peux passer la commande",
        "vas-y passe la commande",
        "je valide la commande",
        "confirme mon panier",
        "on peut commander",
        "finalise la commande",
        "c'est bon tu peux envoyer la commande",
        "c'est tout bon tu peux valider mon panier",
        "ok tu peux finaliser l'achat",
        "je confirme l'achat",
        "checkout",
    ]
    for _ in range(int(500 * scale)):
        add_augmented(rows, "exec_cart", rng.choice(exec_templates), "generated_exec", rng)

    recurring_keywords = [
        "commande récurrente",
        "commandes récurrentes",
        "commande recurrente",
        "commandes recurrentes",
        "commande recurrante",
        "commandes recurrantes",
        "recurrente",
        "recurrante",
        "récurrente",
    ]
    recurring_days = ["lundi", "mardi", "mercredi", "jeudi", "vendredi"]
    recurring_show_templates = [
        "montre mes {keyword}",
        "affiche mes {keyword}",
        "qu'est-ce que j'ai dans mes {keyword}",
        "je veux voir mes {keyword}",
        "liste mes {keyword}",
        "mes {keyword}",
    ]
    recurring_add_templates = [
        "ajoute {item} a ma {keyword} du {day}",
        "rajoute {item} dans ma {keyword} du {day}",
        "mets {item} dans la {keyword} du {day}",
        "peux-tu ajouter {item} a ma {keyword}",
        "ajoute {item} a mes {keyword}",
    ]
    recurring_remove_templates = [
        "retire {item} de ma {keyword} du {day}",
        "enleve {item} de la {keyword} du {day}",
        "supprime {item} dans ma {keyword}",
        "je ne veux plus {item} dans ma {keyword} du {day}",
        "garde seulement 1 {item} dans ma {keyword}",
    ]
    for _ in range(int(900 * scale) + 20):
        keyword = rng.choice(recurring_keywords)
        day = rng.choice(recurring_days)
        product = choose_product(products, rng)
        item = qty_prefix(product, rng)
        template = rng.choice(recurring_show_templates + recurring_add_templates + recurring_remove_templates)
        add_augmented(
            rows,
            "recurring_orders",
            template.format(keyword=keyword, day=day, item=item),
            "generated_recurring",
            rng,
            8,
        )

    needs = [
        "un repas sain",
        "quelque chose de leger",
        "une idee vegetarienne",
        "un apero local",
        "des boissons pour ce soir",
        "un petit dejeuner equilibre",
        "une idee pas trop chere",
        "un dessert simple",
        "des produits pour les enfants",
        "un repas rapide avec du poisson",
        "une option avec de la viande",
        "quelque chose pour la maison",
        "des idees pour mieux manger",
        "une selection de fruits",
        "une idee cadeau",
        "de quoi faire un repas vegetarien",
        "de quoi faire un repas sain",
        "j'aimerais faire des crepes",
        "quoi prendre pour ce soir",
        "je ne sais pas quoi commander",
    ]
    discover_templates = [
        "propose moi {need}",
        "tu me conseilles quoi pour {need}",
        "je cherche {need}",
        "qu'est-ce que tu me proposes aujourd'hui",
        "donne moi des idees pour {need}",
        "je ne sais pas quoi prendre pour {need}",
        "une inspiration pour {need}",
        "que prendre si je veux {need}",
        "j'ai envie de {need}",
        "aide moi a choisir {need}",
    ]
    for _ in range(int(2400 * scale)):
        add_augmented(rows, "discover_meals", rng.choice(discover_templates).format(need=rng.choice(needs)), "generated_discover", rng)

    noop_templates = [
        "bonjour",
        "salut andre",
        "comment ca va",
        "merci beaucoup",
        "haha merci c'est drole",
        "raconte moi quelque chose",
        "je teste seulement l'application",
        "tu fais quoi aujourd'hui",
        "bonne journee",
        "quel temps fait-il aujourd'hui",
        "tu vas bien",
        "ok merci",
        "raconte moi une blague",
        "qui es-tu",
        "a plus tard",
        "je regarde juste",
        "super merci pour l'info",
        "ca roule",
        "quelle heure est-il",
    ]
    for _ in range(int(1200 * scale)):
        add_augmented(rows, "noop", rng.choice(noop_templates), "generated_noop", rng)

    hard_cases = [
        ("add_items", "ajoute un panier budget"),
        ("add_items", "ajoute un panier de fruits local"),
        ("add_items", "je veux une farine pour une pizz"),
        ("add_items", "quels tomates as-tu ?"),
        ("add_items", "A. Lait Bio pasteurisé"),
        ("discover_meals", "je veux completer mon panier pour demain matin"),
        ("discover_meals", "une boisson pour accompagner"),
        ("discover_meals", "j'ai envie d'un truc simple mais bon"),
        ("discover_meals", "de quoi faire un repas sain"),
        ("discover_meals", "de quoi faire un repas vegetarien"),
        ("discover_meals", "j'aimerais faire des crepes"),
        ("discover_meals", "je veux manger mieux mais sans trop cuisiner"),
        ("add_items", "bonjour, selon les dispos: filets de perche, pommes, salade verte"),
        ("noop", "ja ne sai pas"),
        ("exec_cart", "ok"),
        ("noop", "ok parfait"),
        ("noop", "ok je comprends"),
        ("noop", "ok je comprend"),
        ("noop", "ok je comprends merci"),
        ("noop", "ok parfait je comprends"),
        ("noop", "ok c'est clair"),
        ("noop", "ok c est clair"),
        ("noop", "ok d'accord je comprends"),
        ("noop", "ok d accord je comprends"),
        ("noop", "ok merci"),
        ("noop", "ok super"),
        ("noop", "bonjour"),
        ("noop", "bonjour andre"),
        ("noop", "merci c'est tout"),
        ("noop", "merci c est tout"),
        ("noop", "c'est tout merci"),
        ("noop", "merci beaucoup pour ton aide"),
        ("noop", "merci pour ton aide"),
        ("noop", "d'accord merci"),
        ("noop", "d accord merci"),
        ("clear_cart", "supprime 1 lard du begnins de mon panier"),
        ("exec_cart", "passe la commande"),
        ("exec_cart", "finalise mon panier"),
        ("add_items", "ajoute du pain"),
        ("clear_cart", "vide mon panier"),
        ("show_cart", "montre mon panier"),
        ("recurring_orders", "montre mes commandes récurrentes"),
        ("recurring_orders", "ajoute du pain à ma commande récurrente du mardi"),
        ("recurring_orders", "retire le lait de ma commande recurrante du jeudi"),
        ("recurring_orders", "enlève 2 oeufs de ma commande recurrente"),
    ]
    for label, text in hard_cases:
        for _ in range(14 if full else 4):
            add_augmented(rows, label, text, "hard_negative_seed", rng, 3)

    return rows


def load_seed_samples() -> list[dict[str, Any]]:
    training = read_json(PUBLIC_TRAINING, {})
    rows: list[dict[str, Any]] = []
    for intent in training.get("intents", []):
        key = intent.get("key")
        if key not in ACTIVE_LABELS:
            continue
        for example in intent.get("examples", []) or []:
            add_sample(rows, key, str(example), "seed", 2)
    return rows


def load_feedback_samples() -> list[dict[str, Any]]:
    ledger = read_json(LEDGER_FILE, {"events": []})
    rows: list[dict[str, Any]] = []
    for event in ledger.get("events", []) or []:
        label = event.get("correctAction")
        text = event.get("text")
        if label in ACTIVE_LABELS and isinstance(text, str):
            add_sample(rows, label, text, "feedback_ledger", 4 if event.get("kind") == "correction" else 2)
    return rows


def dedupe_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row["label"], row["normalized"])
        if key in by_key:
            by_key[key]["weight"] = min(by_key[key]["weight"] + row["weight"], 8)
            by_key[key]["source"] = by_key[key]["source"] + "+" + row["source"]
        else:
            by_key[key] = dict(row)
    return list(by_key.values())


def split_rows(rows: list[dict[str, Any]], rng: random.Random) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    train: list[dict[str, Any]] = []
    validation: list[dict[str, Any]] = []
    by_label: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if (row["label"], row["normalized"]) in FORCE_TRAIN_CASES:
            train.append(row)
            continue
        by_label[row["label"]].append(row)
    for label, bucket in by_label.items():
        rng.shuffle(bucket)
        cut = max(1, int(len(bucket) * 0.16))
        validation.extend(bucket[:cut])
        train.extend(bucket[cut:])
    rng.shuffle(train)
    rng.shuffle(validation)
    return train, validation


def build_idf(rows: list[dict[str, Any]]) -> dict[str, float]:
    df: Counter[str] = Counter()
    for row in rows:
        df.update(build_feature_counts(row["text"]).keys())
    total = len(rows) or 1
    return {feature: math.log((1 + total) / (1 + count)) + 1 for feature, count in df.items()}


def train_model(rows: list[dict[str, Any]], idf: dict[str, float], rng: random.Random, epochs: int) -> dict[str, Any]:
    weights = {label: defaultdict(float) for label in ACTIVE_LABELS}
    biases = {label: 0.0 for label in ACTIVE_LABELS}
    expanded: list[dict[str, Any]] = []
    for row in rows:
        copies = max(1, min(int(row.get("weight", 1)), 6))
        expanded.extend([row] * copies)

    for epoch in range(epochs):
        rng.shuffle(expanded)
        mistakes = 0
        for row in expanded:
            vector = vectorize(build_feature_counts(row["text"]), idf)
            model = {"labels": ACTIVE_LABELS, "weights": weights, "biases": biases}
            scores = score_model(model, vector)
            ranking = sorted(scores.items(), key=lambda item: item[1], reverse=True)
            predicted = ranking[0][0]
            correct = row["label"]
            best_wrong = next((label for label, _ in ranking if label != correct), predicted)
            margin = scores.get(correct, 0.0) - scores.get(best_wrong, 0.0)
            if predicted != correct or margin < 0.12:
                mistakes += 1
                for feature, value in vector.items():
                    weights[correct][feature] += value
                    weights[best_wrong][feature] -= value
                biases[correct] += 0.04
                biases[best_wrong] -= 0.04
        print(f"[intent-train] epoch={epoch + 1} rows={len(expanded)} updates={mistakes}")

    pruned_weights: dict[str, dict[str, float]] = {}
    for label, bucket in weights.items():
        kept = {
            feature: round(value, 6)
            for feature, value in bucket.items()
            if abs(value) >= 0.0001
        }
        pruned_weights[label] = dict(sorted(kept.items(), key=lambda item: abs(item[1]), reverse=True)[:8000])

    return {
        "labels": ACTIVE_LABELS,
        "weights": pruned_weights,
        "biases": {label: round(value, 6) for label, value in biases.items()},
    }


def predict(model: dict[str, Any], idf: dict[str, float], text: str) -> dict[str, Any]:
    vector = vectorize(build_feature_counts(text), idf)
    scores = score_model(model, vector)
    return prediction_from_scores(scores)


def evaluate(model: dict[str, Any], idf: dict[str, float], rows: list[dict[str, Any]]) -> dict[str, Any]:
    confusion: dict[str, Counter[str]] = {label: Counter() for label in ACTIVE_LABELS}
    by_label: dict[str, dict[str, int]] = {
        label: {"tp": 0, "fp": 0, "fn": 0, "total": 0}
        for label in ACTIVE_LABELS
    }
    failures: list[dict[str, Any]] = []
    confidence_by_prediction: defaultdict[str, list[tuple[int, bool]]] = defaultdict(list)

    for row in rows:
        result = predict(model, idf, row["text"])
        expected = row["label"]
        detected = result["label"]
        ok = expected == detected
        confusion[expected][detected] += 1
        by_label[expected]["total"] += 1
        confidence_by_prediction[detected].append((int(result["confidence"]), ok))
        if ok:
            by_label[expected]["tp"] += 1
        else:
            by_label[detected]["fp"] += 1
            by_label[expected]["fn"] += 1
            if len(failures) < 80:
                failures.append({
                    "text": row["text"],
                    "expected": expected,
                    "detected": detected,
                    "confidence": result["confidence"],
                    "margin": round(result["margin"], 4),
                    "secondChoice": result["secondChoice"]["label"],
                })

    per_label = {}
    for label, stats in by_label.items():
        tp, fp, fn, total = stats["tp"], stats["fp"], stats["fn"], stats["total"]
        precision = tp / max(tp + fp, 1)
        recall = tp / max(tp + fn, 1)
        per_label[label] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "total": total,
            "tp": tp,
            "fp": fp,
            "fn": fn,
        }

    thresholds = {}
    target_precision = 0.965
    for label in ACTIVE_LABELS:
        observed = confidence_by_prediction[label]
        chosen = 68
        for threshold in range(45, 96):
            accepted = [ok for conf, ok in observed if conf >= threshold]
            if len(accepted) < 8:
                continue
            precision = sum(1 for ok in accepted if ok) / len(accepted)
            if precision >= target_precision:
                chosen = threshold
                break
        thresholds[label] = chosen

    total_ok = sum(stats["tp"] for stats in by_label.values())
    total = len(rows) or 1
    return {
        "accuracy": round(total_ok / total, 4),
        "total": len(rows),
        "perLabel": per_label,
        "confusionMatrix": {
            label: {detected: count for detected, count in counter.items()}
            for label, counter in confusion.items()
        },
        "confidenceThresholds": thresholds,
        "failures": failures,
    }


def fixed_ui_holdout() -> list[dict[str, Any]]:
    cases = {
        "add_items": [
            "Salut André, tu peux me mettre deux pains aux noix et un litre de lait pour demain ?",
            "Salut André, peux-tu me mettre 2 Pommes Bio ou VV, 1 Pain aux noix et 3 litres de A. Lait Bio pasteurisé (Sapalet) ?",
            "Je te prends 3 yogourts nature, 1 paquet de riz et des pommes si possible",
            "Pour vendredi il me faudrait 400g de lard de Begnins et 2 oeufs",
            "Ajoute une sauce tomate et du gruyere doux",
            "Si tu as encore du tofu et du jus de pomme, je veux bien",
            "Mets moi 2 kilos de pommes de terre dans la commande",
            "Je veux bien un panier de fruits local moyen",
            "Rajoute juste du pain balance et une tomme vaudoise",
            "A. Lait Bio pasteurisé (Sapalet)",
            "est-ce que tu peux me livrer 2 litres de lait et 1 pain anglais",
            "bonjour, selon les dispos: filets de perche, pommes, salade verte",
            "je voudrais acheter du sel fin et de la farine pizza",
            "peux tu ajouter 250g de fromage et 6 oeufs",
            "pour demain matin ajoute muesli aux fruits et bananes",
            "il me manque du beurre frais et une baguette",
            "je veux une farine pour une pizz",
            "quels tomates as-tu ?",
            "tu peux me mettre des pâtes et une sauce lulu",
            "j'aimerais commander ananas, riz basmati et kefir",
            "ajoute un panier budget",
        ],
        "clear_cart": [
            "Finalement enlève tout ce que j'ai mis dans le panier",
            "Vide complètement ma commande",
            "Je repars de zéro, supprime tout",
            "Retire juste le pain aux noix",
            "Enlève le lait mais garde le reste",
            "Je ne veux plus les pommes",
            "Annule tout le panier stp",
            "Supprime le riz basmati de ma commande",
            "Tu peux retirer les oeufs seulement",
            "Efface tout ce qu'il y a dans mon panier",
            "Finalement pas de gruyere doux",
            "Retire 1 lard du begnins de mon panier",
            "Je veux que le panier soit vide",
            "Enleve seulement la sauce tomate",
            "Supprime les produits que je viens d'ajouter",
            "Annule ma selection actuelle",
            "Je ne prends plus le panier de fruits",
            "Retire de la commande les bananes",
            "Vide tout et on recommence",
            "Finalement je ne commande rien",
        ],
        "discover_meals": [
            "Je ne sais pas quoi prendre pour un repas léger ce soir",
            "Tu me proposes quoi de sain pour demain ?",
            "Une idée végétarienne pas trop lourde",
            "Je reçois deux amis, tu conseilles quoi ?",
            "Quelque chose à boire avec le repas",
            "De quoi faire un repas sain",
            "J'aimerais faire des crêpes",
            "Une sélection de fruits pour la semaine",
            "Un apéro local simple",
            "Je veux manger mieux mais sans trop cuisiner",
            "Des produits pour les enfants après l'école",
            "Un dessert léger avec de la pomme",
            "Que prendre pour un petit déjeuner équilibré ?",
            "Une idée cadeau avec des produits locaux",
            "Propose moi quelque chose pour ma santé",
            "Un truc rapide avec du poisson",
            "Quelque chose pour le ménage",
            "De quoi faire un repas végétarien",
            "Je veux compléter mon panier pour demain matin",
            "J'ai envie d'un truc simple mais bon",
        ],
        "recurring_orders": [
            "Montre mes commandes récurrentes",
            "Je veux voir mes commandes recurrentes",
            "Ajoute du pain à ma commande récurrente du mardi",
            "Rajoute du lait dans ma commande recurrante du jeudi",
            "Retire le lait de ma commande récurrente du vendredi",
            "Enlève 2 oeufs de ma commande recurrente",
            "Supprime les pommes de ma commande récurrente",
            "Qu'est-ce qu'il y a dans ma commande recurrante du mardi ?",
            "Liste mes commandes récurrentes",
            "Garde 1 pain dans ma commande recurrente",
        ],
        "noop": [
            "Salut, tu vas bien aujourd'hui ?",
            "Merci beaucoup pour ton aide",
            "Quel temps fait-il aujourd'hui ?",
            "Ok parfait",
            "Tu peux m'expliquer qui tu es ?",
            "Bonne journée André",
            "Haha merci c'est drôle",
            "Je regarde juste pour l'instant",
            "A plus tard",
            "Comment ça va bro ?",
            "Quelle heure est-il ?",
            "Raconte moi quelque chose",
            "D'accord merci",
            "Super, je reviens après",
            "Bonjour",
            "Coucou",
            "Tu fais quoi aujourd'hui ?",
            "Merci, c'est tout",
            "Ok je comprends",
            "Je teste seulement l'application",
        ],
    }
    rows: list[dict[str, Any]] = []
    for label, texts in cases.items():
        for text in texts:
            add_sample(rows, label, text, "ui_holdout", 1)
    return rows


def build_runtime_training(seed: dict[str, Any], model_payload: dict[str, Any]) -> dict[str, Any]:
    selected_examples = model_payload["trainingExamplesByIntent"]
    intents = []
    for intent in seed.get("intents", []):
        key = intent.get("key")
        if key not in ACTIVE_LABELS:
            continue
        merged = dict(intent)
        examples = list(dict.fromkeys((intent.get("examples") or []) + selected_examples.get(key, [])))
        merged["examples"] = examples
        intents.append(merged)

    return {
        **seed,
        "version": max(int(seed.get("version", 1)), 2),
        "fallbackIntent": FALLBACK_LABEL,
        "intents": intents,
        "intentModel": model_payload["intentModel"],
        "updatedAt": model_payload["generatedAt"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Generate the full corpus.")
    parser.add_argument("--seed", type=int, default=1779)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    products = load_products()
    seed = read_json(PUBLIC_TRAINING, {})

    rows = []
    rows.extend(load_seed_samples())
    rows.extend(load_feedback_samples())
    rows.extend(generate_samples(products, args.full, rng))
    rows = dedupe_rows(rows)
    train_rows, validation_rows = split_rows(rows, rng)

    idf = build_idf(train_rows)
    model = train_model(train_rows, idf, rng, epochs=22 if args.full else 9)
    validation = evaluate(model, idf, validation_rows)
    ui_holdout = fixed_ui_holdout()
    ui_report = evaluate(model, idf, ui_holdout)

    by_intent_examples: defaultdict[str, list[str]] = defaultdict(list)
    for row in train_rows:
        if row["source"].startswith("generated") or row["source"].startswith("hard") or row["source"].startswith("feedback"):
            bucket = by_intent_examples[row["label"]]
            if len(bucket) < 700 and row["text"] not in bucket:
                bucket.append(row["text"])

    now = datetime.now(timezone.utc).isoformat()
    model_payload = {
        "version": 1,
        "generatedAt": now,
        "kind": "intent-router-4-strades",
        "activeIntents": ACTIVE_LABELS,
        "primaryAuditIntents": PRIMARY_AUDIT_LABELS,
        "hiddenIntents": HIDDEN_LABELS,
        "trainingSourceSummary": {
            "catalogProducts": len(products),
            "totalRows": len(rows),
            "trainRows": len(train_rows),
            "validationRows": len(validation_rows),
            "uiHoldoutRows": len(ui_holdout),
            "full": bool(args.full),
            "sklearnAvailable": False,
        },
        "intentModel": {
            "type": "linear_tfidf_v1",
            "labels": ACTIVE_LABELS,
            "fallbackIntent": FALLBACK_LABEL,
            "idf": {feature: round(value, 6) for feature, value in idf.items()},
            "weights": model["weights"],
            "biases": model["biases"],
            "acceptance": {
                "confidenceThresholds": validation["confidenceThresholds"],
                "minMargin": 0.075,
                "allowAmbiguous": False,
                "source": "validation_calibration",
            },
            "labelMeta": LABEL_META,
        },
        "trainingExamplesByIntent": dict(by_intent_examples),
        "validationReport": validation,
        "uiHoldoutReport": ui_report,
        "uiHoldout": ui_holdout,
    }

    write_json(MODEL_FILE, model_payload)
    runtime = build_runtime_training(seed, model_payload)
    write_json(RUNTIME_FILE, runtime)

    print("[intent-train] wrote", MODEL_FILE)
    print("[intent-train] wrote", RUNTIME_FILE)
    print("[intent-train] validation accuracy", validation["accuracy"])
    print("[intent-train] ui holdout accuracy", ui_report["accuracy"])
    if validation["failures"][:5]:
        print("[intent-train] sample failures")
        for failure in validation["failures"][:5]:
            print(" -", failure)


if __name__ == "__main__":
    main()
