(function(global){
  "use strict";

  function clamp(value, min, max){
    return Math.min(max, Math.max(min, value));
  }

  function normalizeText(input){
    return String(input || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(text){
    const normalized = normalizeText(text);
    return normalized ? normalized.split(" ").filter(Boolean) : [];
  }

  function buildFeatureCounts(text){
    const normalized = normalizeText(text);
    const counts = new Map();

    if (!normalized) {
      return counts;
    }

    const tokens = tokenize(normalized);

    function add(feature, amount){
      if (!feature) return;
      counts.set(feature, (counts.get(feature) || 0) + (amount || 1));
    }

    tokens.forEach((token, index) => {
      add("w:" + token, 1.8);

      if (token.length >= 4) {
        add("p:" + token.slice(0, 4), 0.8);
        add("s:" + token.slice(-4), 0.8);
      }

      if (index < tokens.length - 1) {
        add("b:" + token + "_" + tokens[index + 1], 1.4);
      }

      if (index < tokens.length - 2) {
        add("t:" + token + "_" + tokens[index + 1] + "_" + tokens[index + 2], 1.1);
      }
    });

    const source = " " + normalized + " ";
    for (let size = 3; size <= 5; size += 1) {
      for (let index = 0; index <= source.length - size; index += 1) {
        const gram = source.slice(index, index + size);
        if (!gram.trim()) continue;
        add("c:" + gram, 0.55);
      }
    }

    return counts;
  }

  function buildIdf(samples){
    const df = new Map();
    const total = samples.length || 1;

    samples.forEach((sample) => {
      const features = new Set(sample.counts.keys());
      features.forEach((feature) => {
        df.set(feature, (df.get(feature) || 0) + 1);
      });
    });

    const idf = new Map();
    df.forEach((count, feature) => {
      idf.set(feature, Math.log((1 + total) / (1 + count)) + 1);
    });

    return idf;
  }

  function vectorizeCounts(counts, idf){
    const weights = new Map();
    let normSquared = 0;

    counts.forEach((count, feature) => {
      const weight = (1 + Math.log(count)) * (idf.get(feature) || 1);
      weights.set(feature, weight);
      normSquared += weight * weight;
    });

    return {
      weights,
      norm: Math.sqrt(normSquared) || 1
    };
  }

  function cosineSimilarity(left, right){
    const leftWeights = left.weights;
    const rightWeights = right.weights;
    const iterate = leftWeights.size <= rightWeights.size ? leftWeights : rightWeights;
    const other = iterate === leftWeights ? rightWeights : leftWeights;
    let dot = 0;

    iterate.forEach((weight, feature) => {
      if (other.has(feature)) {
        dot += weight * other.get(feature);
      }
    });

    return dot / ((left.norm || 1) * (right.norm || 1));
  }

  function averageVectors(vectors){
    const aggregate = new Map();

    vectors.forEach((vector) => {
      vector.weights.forEach((weight, feature) => {
        aggregate.set(feature, (aggregate.get(feature) || 0) + weight);
      });
    });

    const count = Math.max(vectors.length, 1);
    let normSquared = 0;

    aggregate.forEach((weight, feature) => {
      const mean = weight / count;
      aggregate.set(feature, mean);
      normSquared += mean * mean;
    });

    return {
      weights: aggregate,
      norm: Math.sqrt(normSquared) || 1
    };
  }

  function buildStopwordSet(commonWords, intentWords){
    const set = new Set();
    [...(commonWords || []), ...(intentWords || [])].forEach((entry) => {
      tokenize(entry).forEach((token) => set.add(token));
    });
    return set;
  }

  function extractEntity(text, intentConfig, commonStopwords){
    const canonical = intentConfig.canonical || {};
    const stopwords = buildStopwordSet(commonStopwords, canonical.stopwords || []);
    const rawTokens = tokenize(text);
    const kept = [];

    rawTokens.forEach((token, index) => {
      const previous = rawTokens[index - 1] || "";
      const isNumeric = /^\d+$/.test(token);
      const isQuantityUnit = /^(x|kg|g|gr|gramme|grammes|ml|l|litre|litres|piece|pieces)$/.test(token);

      if (!stopwords.has(token) || isNumeric || isQuantityUnit) {
        if (!(token === previous && !isNumeric)) {
          kept.push(token);
        }
      }
    });

    return kept.join(" ").trim();
  }

  function sentenceCase(text){
    const value = String(text || "").trim();
    if (!value) return "";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function buildCanonical(text, intent, commonStopwords, nearestExample){
    const canonical = intent.canonical || {};

    if (canonical.mode === "entity") {
      const entity = extractEntity(text, intent, commonStopwords);
      if (entity) {
        const template = canonical.template || "{entity}";
        return sentenceCase(template.replace("{entity}", entity));
      }

      if (nearestExample) {
        const exampleEntity = extractEntity(nearestExample.text, intent, commonStopwords);
        if (exampleEntity) {
          const template = canonical.template || "{entity}";
          return sentenceCase(template.replace("{entity}", exampleEntity));
        }
      }
    }

    return canonical.default || intent.label || "Reponse generale";
  }

  function buildReason(intent, nearestExample){
    if (nearestExample && nearestExample.text) {
      return intent.reason + ' Exemple proche: "' + nearestExample.text + '".';
    }
    return intent.reason || "Le texte ressemble a cette famille d'intention.";
  }

  function softmaxProbability(sortedCandidates, topCandidate){
    const temperatures = sortedCandidates.map((candidate) => Math.exp((candidate.score || 0) * 10));
    const total = temperatures.reduce((sum, value) => sum + value, 0) || 1;
    const topIndex = sortedCandidates.indexOf(topCandidate);
    return topIndex >= 0 ? temperatures[topIndex] / total : 0;
  }

  function buildClassifier(training){
    const intents = Array.isArray(training.intents) ? training.intents : [];
    const samples = [];
    const samplesByIntent = new Map();

    intents.forEach((intent) => {
      const examples = Array.isArray(intent.examples) ? intent.examples : [];
      const bucket = [];
      examples.forEach((text) => {
        const counts = buildFeatureCounts(text);
        const sample = { intentKey: intent.key, text, counts, vector: null };
        bucket.push(sample);
        samples.push(sample);
      });
      samplesByIntent.set(intent.key, bucket);
    });

    const idf = buildIdf(samples);

    samples.forEach((sample) => {
      sample.vector = vectorizeCounts(sample.counts, idf);
    });

    const centroids = new Map();
    intents.forEach((intent) => {
      const intentSamples = samplesByIntent.get(intent.key) || [];
      centroids.set(intent.key, averageVectors(intentSamples.map((sample) => sample.vector)));
    });

    const fallbackIntent = intents.find((intent) => intent.key === training.fallbackIntent) || intents[intents.length - 1];
    const commonStopwords = training.common?.stopwords || [];

    return {
      predict(text){
        const normalized = normalizeText(text);

        if (!normalized) {
          return {
            family: "general",
            actionKey: fallbackIntent?.key || "noop",
            actionLabel: fallbackIntent?.label || "NOOP",
            confidence: 0,
            canonical: fallbackIntent?.canonical?.default || "Repondre naturellement",
            planner: fallbackIntent?.planner || "planner/general",
            reason: fallbackIntent?.reason || "Aucune action claire detectee pour l'instant."
          };
        }

        const inputVector = vectorizeCounts(buildFeatureCounts(normalized), idf);

        const candidates = intents.map((intent) => {
          const intentSamples = samplesByIntent.get(intent.key) || [];
          let bestExample = null;
          let bestExampleScore = 0;
          const topScores = [];

          intentSamples.forEach((sample) => {
            const similarity = cosineSimilarity(inputVector, sample.vector);
            if (similarity > bestExampleScore) {
              bestExampleScore = similarity;
              bestExample = sample;
            }
            topScores.push(similarity);
          });

          topScores.sort((left, right) => right - left);
          const topAverage = topScores.slice(0, 3).reduce((sum, value) => sum + value, 0) / Math.max(Math.min(topScores.length, 3), 1);
          const centroidScore = cosineSimilarity(inputVector, centroids.get(intent.key));
          const score = (bestExampleScore * 0.55) + (topAverage * 0.2) + (centroidScore * 0.25);

          return {
            intent,
            score,
            bestExample,
            centroidScore,
            bestExampleScore
          };
        });

        candidates.sort((left, right) => right.score - left.score);

        let best = candidates[0];
        const second = candidates[1] || { score: 0 };
        const fallbackCandidate = candidates.find((candidate) => candidate.intent.key === training.fallbackIntent);

        if (
          fallbackCandidate &&
          best.intent.key !== fallbackCandidate.intent.key &&
          best.score < 0.19 &&
          fallbackCandidate.score >= best.score - 0.02
        ) {
          best = fallbackCandidate;
        }

        const probability = softmaxProbability(candidates, best);
        const margin = clamp((best.score || 0) - (second.score || 0), 0, 1);
        let confidence = Math.round(clamp((probability * 0.7 + margin * 0.3) * 100, 9, 99));

        if ((best.score || 0) < 0.16) {
          confidence = Math.min(confidence, 54);
        }

        return {
          family: best.intent.family || "general",
          actionKey: best.intent.key,
          actionLabel: best.intent.label || best.intent.key.toUpperCase(),
          confidence,
          canonical: buildCanonical(text, best.intent, commonStopwords, best.bestExample),
          planner: best.intent.planner || ("planner/" + best.intent.key),
          reason: buildReason(best.intent, best.bestExample),
          score: best.score,
          example: best.bestExample?.text || ""
        };
      }
    };
  }

  async function create(source){
    let training = source;

    if (typeof source === "string") {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error("Impossible de charger le training d'intentions.");
      }
      training = await response.json();
    }

    return buildClassifier(training || {});
  }

  global.ZeloIntentClassifier = {
    create,
    normalizeText
  };
})(window);
