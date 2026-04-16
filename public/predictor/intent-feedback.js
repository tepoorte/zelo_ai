(function(global){
  "use strict";

  async function fetchTraining(){
    const response = await fetch("/ai/intent-training");
    const data = await response.json();
    if (!response.ok || !data?.ok || !data?.training) {
      throw new Error(data?.error || "Impossible de charger le training d'intentions.");
    }
    return data.training;
  }

  async function submitFeedback(payload){
    const response = await fetch("/ai/intent-feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data?.ok || !data?.training) {
      throw new Error(data?.error || "Impossible d'enregistrer le feedback.");
    }
    return data;
  }

  function downloadTraining(training, filename){
    const blob = new Blob([JSON.stringify(training, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "intent-training-enriched.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  global.ZeloIntentFeedback = {
    fetchTraining,
    submitFeedback,
    downloadTraining
  };
})(window);
