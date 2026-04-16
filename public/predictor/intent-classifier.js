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
      add("w:" + token, 2.2);

      if (token.length >= 4) {
        add("p:" + token.slice(0, 4), 1);
        add("s:" + token.slice(-4), 1);
      }

      if (index < tokens.length - 1) {
        add("b:" + token + "_" + tokens[index + 1], 1.8);
      }

      if (index < tokens.length - 2) {
        add("t:" + token + "_" + tokens[index + 1] + "_" + tokens[index + 2], 1.15);
      }
    });

    const source = " " + normalized + " ";
    for (let size = 3; size <= 5; size += 1) {
      for (let index = 0; index <= source.length - size; index += 1) {
        const gram = source.slice(index, index + size);
        if (!gram.trim()) continue;
        add("c:" + gram, size === 3 ? 0.75 : size === 4 ? 0.62 : 0.48);
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
    const leftWeights = left?.weights || new Map();
    const rightWeights = right?.weights || new Map();
    const iterate = leftWeights.size <= rightWeights.size ? leftWeights : rightWeights;
    const other = iterate === leftWeights ? rightWeights : leftWeights;
    let dot = 0;

    iterate.forEach((weight, feature) => {
      if (other.has(feature)) {
        dot += weight * other.get(feature);
      }
    });

    return dot / (((left?.norm) || 1) * (((right?.norm) || 1)));
  }

  function averageSampleVectors(samples){
    const aggregate = new Map();
    let totalWeight = 0;

    samples.forEach((sample) => {
      const weight = Math.max(1, sample.weight || 1);
      totalWeight += weight;
      sample.vector.weights.forEach((value, feature) => {
        aggregate.set(feature, (aggregate.get(feature) || 0) + value * weight);
      });
    });

    if (!totalWeight) {
      return { weights: new Map(), norm: 1 };
    }

    let normSquared = 0;
    aggregate.forEach((value, feature) => {
      const mean = value / totalWeight;
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

      if (nearestExample?.text) {
        const exampleEntity = extractEntity(nearestExample.text, intent, commonStopwords);
        if (exampleEntity) {
          const template = canonical.template || "{entity}";
          return sentenceCase(template.replace("{entity}", exampleEntity));
        }
      }
    }

    return canonical.default || intent.label || "Reponse generale";
  }

  function buildReason(intent, nearestExample, extra){
    let base = intent.reason || "Le texte ressemble a cette famille d'intention.";
    if (nearestExample?.text) {
      base += ' Exemple proche: "' + nearestExample.text + '".';
    }
    if (extra) {
      base += " " + extra;
    }
    return base;
  }

  function softmaxProbability(sortedCandidates, topCandidate){
    const temperatures = sortedCandidates.map((candidate) => Math.exp((candidate.finalScore || 0) * 8));
    const total = temperatures.reduce((sum, value) => sum + value, 0) || 1;
    const topIndex = sortedCandidates.indexOf(topCandidate);
    return topIndex >= 0 ? temperatures[topIndex] / total : 0;
  }

  function createSample(intentKey, example){
    const text = typeof example === "string" ? example : example?.text;
    const normalized = normalizeText(text);
    return {
      intentKey,
      text,
      normalized,
      weight: Math.max(1, Math.min(Number(typeof example === "string" ? 1 : example?.weight ?? example?.count ?? 1) || 1, 8)),
      counts: buildFeatureCounts(text),
      vector: null
    };
  }

  function createLinearModel(intents){
    const weights = {};
    const biases = {};

    intents.forEach((intent) => {
      weights[intent.key] = Object.create(null);
      biases[intent.key] = 0;
    });

    return { weights, biases };
  }

  function scoreLinearModel(model, counts, intents){
    return intents.map((intent) => {
      const bucket = model.weights[intent.key] || Object.create(null);
      let score = model.biases[intent.key] || 0;
      counts.forEach((count, feature) => {
        score += (bucket[feature] || 0) * count;
      });
      return {
        intentKey: intent.key,
        score
      };
    });
  }

  function updateLinearModel(model, counts, correctKey, predictedKey, learningRate){
    if (!correctKey || !predictedKey || correctKey === predictedKey) {
      return;
    }

    const positive = model.weights[correctKey] || (model.weights[correctKey] = Object.create(null));
    const negative = model.weights[predictedKey] || (model.weights[predictedKey] = Object.create(null));
    const step = learningRate || 1;

    counts.forEach((count, feature) => {
      const delta = count * step;
      positive[feature] = (positive[feature] || 0) + delta;
      negative[feature] = (negative[feature] || 0) - delta;
    });

    model.biases[correctKey] = (model.biases[correctKey] || 0) + step;
    model.biases[predictedKey] = (model.biases[predictedKey] || 0) - step;
  }

  function trainLinearModel(intents, samples, epochs){
    const model = createLinearModel(intents);
    const trainingRows = [];

    samples.forEach((sample) => {
      const copies = Math.max(1, Math.min(sample.weight || 1, 6));
      for (let index = 0; index < copies; index += 1) {
        trainingRows.push(sample);
      }
    });

    const loopCount = epochs || 6;

    for (let epoch = 0; epoch < loopCount; epoch += 1) {
      trainingRows.forEach((sample) => {
        const scores = scoreLinearModel(model, sample.counts, intents).sort((left, right) => right.score - left.score);
        const predictedKey = scores[0]?.intentKey;
        if (predictedKey !== sample.intentKey) {
          updateLinearModel(model, sample.counts, sample.intentKey, predictedKey, 1);
        }
      });
    }

    return model;
  }

  function mapLinearScores(linearScores){
    const max = linearScores[0]?.score ?? 0;
    const min = linearScores[linearScores.length - 1]?.score ?? 0;

    return linearScores.reduce((acc, entry) => {
      acc[entry.intentKey] = max === min ? 0.5 : (entry.score - min) / (max - min);
      return acc;
    }, {});
  }

  function buildOverrideMap(training){
    return Object.entries(training.feedback?.overrides || {}).reduce((acc, [key, value]) => {
      acc[normalizeText(key)] = value;
      return acc;
    }, {});
  }

  function buildClassifier(training){
    const intents = Array.isArray(training.intents) ? training.intents : [];
    const fallbackIntent = intents.find((intent) => intent.key === training.fallbackIntent) || intents[intents.length - 1];
    const commonStopwords = training.common?.stopwords || [];
    const overrideMap = buildOverrideMap(training);
    const feedbackReinforced = training.feedback?.reinforced || {};
    const samples = [];
    const samplesByIntent = new Map();

    intents.forEach((intent) => {
      const bucket = [];
      const examples = Array.isArray(intent.examples) ? intent.examples : [];

      examples.forEach((example) => {
        const sample = createSample(intent.key, example);
        bucket.push(sample);
        samples.push(sample);
      });

      const reinforced = Array.isArray(feedbackReinforced[intent.key]) ? feedbackReinforced[intent.key] : [];
      reinforced.forEach((entry) => {
        const sample = createSample(intent.key, { text: entry.text, count: entry.count });
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
      centroids.set(intent.key, averageSampleVectors(intentSamples));
    });

    const linearModel = trainLinearModel(intents, samples, 7);

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

        const overrideIntentKey = overrideMap[normalized];
        if (overrideIntentKey) {
          const overrideIntent = intents.find((intent) => intent.key === overrideIntentKey);
          if (overrideIntent) {
            return {
              family: overrideIntent.family || "general",
              actionKey: overrideIntent.key,
              actionLabel: overrideIntent.label || overrideIntent.key.toUpperCase(),
              confidence: 99,
              canonical: buildCanonical(text, overrideIntent, commonStopwords, null),
              planner: overrideIntent.planner || ("planner/" + overrideIntent.key),
              reason: "Prediction renforcee par un feedback explicite deja confirme.",
              score: 1,
              example: ""
            };
          }
        }

        const inputCounts = buildFeatureCounts(normalized);
        const inputVector = vectorizeCounts(inputCounts, idf);

        const linearScores = scoreLinearModel(linearModel, inputCounts, intents).sort((left, right) => right.score - left.score);
        const linearMap = mapLinearScores(linearScores);
        const topLinearKey = linearScores[0]?.intentKey || fallbackIntent?.key;

        const candidates = intents.map((intent) => {
          const intentSamples = samplesByIntent.get(intent.key) || [];
          let bestExample = null;
          let bestExampleScore = 0;
          const topScores = [];

          intentSamples.forEach((sample) => {
            const similarity = cosineSimilarity(inputVector, sample.vector);
            const weightedSimilarity = similarity + Math.min((sample.weight - 1) * 0.015, 0.06);
            if (weightedSimilarity > bestExampleScore) {
              bestExampleScore = weightedSimilarity;
              bestExample = sample;
            }
            topScores.push(weightedSimilarity);
          });

          topScores.sort((left, right) => right - left);
          const topAverage = topScores.slice(0, 3).reduce((sum, value) => sum + value, 0) / Math.max(Math.min(topScores.length, 3), 1);
          const centroidScore = cosineSimilarity(inputVector, centroids.get(intent.key));
          const semanticScore = (bestExampleScore * 0.52) + (topAverage * 0.2) + (centroidScore * 0.28);
          const linearScore = linearMap[intent.key] ?? 0.5;
          const agreementBoost = topLinearKey === intent.key ? 0.05 : 0;
          const finalScore = (semanticScore * 0.62) + (linearScore * 0.33) + agreementBoost;

          return {
            intent,
            finalScore,
            semanticScore,
            linearScore,
            bestExample,
            bestExampleScore,
            centroidScore
          };
        });

        candidates.sort((left, right) => right.finalScore - left.finalScore);

        let best = candidates[0];
        const second = candidates[1] || { finalScore: 0, intent: fallbackIntent };
        const fallbackCandidate = candidates.find((candidate) => candidate.intent.key === training.fallbackIntent);

        if (
          fallbackCandidate &&
          best.intent.key !== fallbackCandidate.intent.key &&
          best.finalScore < 0.22 &&
          fallbackCandidate.finalScore >= best.finalScore - 0.025
        ) {
          best = fallbackCandidate;
        }

        const probability = softmaxProbability(candidates, best);
        const margin = clamp((best.finalScore || 0) - (second.finalScore || 0), 0, 1);
        const sameSignal = topLinearKey === best.intent.key ? 1 : 0;
        let confidence = Math.round(clamp((probability * 0.52 + margin * 0.33 + sameSignal * 0.15) * 100, 8, 99));

        if ((best.finalScore || 0) < 0.18) {
          confidence = Math.min(confidence, 56);
        }

        if (second.finalScore >= best.finalScore - 0.025) {
          confidence = Math.min(confidence, 64);
        }

        const ambiguity = second?.intent?.key && second.intent.key !== best.intent.key && second.finalScore >= best.finalScore - 0.035;
        const extraReason = ambiguity
          ? `Alternative proche: ${second.intent.label || second.intent.key.toUpperCase()}.`
          : sameSignal
            ? "Les couches exemple et apprentissage pointent dans la meme direction."
            : "";

        return {
          family: best.intent.family || "general",
          actionKey: best.intent.key,
          actionLabel: best.intent.label || best.intent.key.toUpperCase(),
          confidence,
          canonical: buildCanonical(text, best.intent, commonStopwords, best.bestExample),
          planner: best.intent.planner || ("planner/" + best.intent.key),
          reason: buildReason(best.intent, best.bestExample, extraReason),
          score: best.finalScore,
          example: best.bestExample?.text || "",
          secondChoice: second?.intent ? {
            actionKey: second.intent.key,
            actionLabel: second.intent.label || second.intent.key.toUpperCase(),
            score: second.finalScore
          } : null,
          ambiguity
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
