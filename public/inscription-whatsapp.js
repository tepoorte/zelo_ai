(() => {
  "use strict";

  const VIEWS = [
    "loading-view",
    "registration-view",
    "verification-view",
    "connection-view",
    "success-view",
    "error-view",
  ];

  const statusMessage = document.getElementById("status-message");
  const pageTitle = document.getElementById("page-title");
  const pageDescription = document.getElementById("page-description");

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fragmentToken = (fragment.get("token") || "").trim();
  const historyToken = String(window.history.state?.whatsappOnboardingToken || "").trim();
  const token = fragmentToken || historyToken;

  // Conserve la capacité uniquement dans l'entrée d'historique courante afin
  // qu'un rafraîchissement fonctionne, sans l'exposer dans l'URL ni dans un
  // stockage persistant du navigateur.
  if (fragmentToken) {
    window.history.replaceState(
      { ...(window.history.state || {}), whatsappOnboardingToken: fragmentToken },
      document.title,
      `${window.location.pathname}${window.location.search}`
    );
  }

  function clearTokenState() {
    const nextState = { ...(window.history.state || {}) };
    delete nextState.whatsappOnboardingToken;
    window.history.replaceState(nextState, document.title, `${window.location.pathname}${window.location.search}`);
  }

  function showView(viewId, options = {}) {
    for (const id of VIEWS) {
      document.getElementById(id).hidden = id !== viewId;
    }

    statusMessage.textContent = "";
    if (options.title) pageTitle.textContent = options.title;
    if (options.description) pageDescription.textContent = options.description;

    const view = document.getElementById(viewId);
    const heading = view.querySelector("h2");
    if (options.focus !== false && heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }

  function showFormError(message) {
    statusMessage.classList.remove("is-success");
    statusMessage.textContent = message;
    statusMessage.focus?.();
  }

  function showFatalError(options = {}) {
    showView("error-view", {
      title: options.title || "Lien indisponible",
      description: options.description || "La connexion n’a pas pu être vérifiée.",
    });
    document.getElementById("error-description").textContent =
      options.message || "Ce lien n’est plus valide. Retourne dans WhatsApp et demande un nouveau lien à l’assistant Zélo.";
    document.getElementById("retry-button").hidden = options.retry !== true;
  }

  function showSuccess() {
    clearTokenState();
    showView("success-view", {
      title: "Compte connecté",
      description: "Tu peux maintenant utiliser toutes les fonctions de l’assistant.",
    });
  }

  function setBusy(form, busy) {
    const submitButton = form.querySelector('button[type="submit"]');
    const fields = form.querySelectorAll("input, select, button");
    for (const field of fields) field.disabled = busy;
    submitButton.dataset.defaultLabel ||= submitButton.textContent;
    submitButton.textContent = busy ? "Un instant…" : submitButton.dataset.defaultLabel;
    form.setAttribute("aria-busy", String(busy));
  }

  async function postJson(endpoint, payload) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      const error = new Error("Le réseau ne répond pas. Vérifie ta connexion et réessaie.");
      error.code = cause?.name === "AbortError" ? "request_timeout" : "network_error";
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true) {
      const message = typeof body?.message === "string" ? body.message : "request_failed";
      const error = new Error(message);
      error.code = typeof body?.code === "string" ? body.code : "request_failed";
      error.httpStatus = response.status;
      throw error;
    }
    return body;
  }

  async function loadRegions() {
    const response = await postJson("/integrations/meta/whatsapp/onboarding/regions", { token });
    const select = document.getElementById("region");
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choisis ta région";
    select.appendChild(placeholder);
    for (const region of response.regions || []) {
      const option = document.createElement("option");
      option.value = String(region.id || "");
      option.textContent = String(region.name || "");
      if (option.value && option.textContent) select.appendChild(option);
    }
    if (select.options.length === 1) {
      throw new Error("Aucune région Zélo n’est disponible actuellement.");
    }
  }

  function configureVerification(codeRequired) {
    const codeField = document.getElementById("email-code-field");
    const codeInput = document.getElementById("email-code");
    const resendButton = document.getElementById("resend-code-button");
    const heading = document.getElementById("verification-title");
    const explanation = document.querySelector("#verification-view .step-heading p");
    const submitButton = document.querySelector('#verification-form button[type="submit"]');
    codeField.hidden = !codeRequired;
    codeInput.required = codeRequired;
    if (!codeRequired) codeInput.value = "";
    resendButton.hidden = !codeRequired;
    heading.textContent = codeRequired ? "Confirmer mon adresse" : "Finaliser la connexion";
    explanation.textContent = codeRequired
      ? "Saisis le code reçu par courriel pour terminer l’inscription."
      : "Ton adresse est déjà confirmée. Retape simplement ton mot de passe.";
    submitButton.textContent = codeRequired ? "Valider et me connecter" : "Me connecter";
  }

  function configureConnection(emailRequired) {
    const emailField = document.getElementById("existing-email-field");
    const emailInput = document.getElementById("existing-email");
    emailField.hidden = !emailRequired;
    emailInput.required = emailRequired;
    if (!emailRequired) emailInput.value = "";
  }

  async function showStage(status) {
    if (status.stage === "completed") {
      showSuccess();
      return;
    }

    if (status.mode === "new_account" && status.stage === "offered") {
      await loadRegions();
      showView("registration-view", {
        title: "Créer mon compte",
        description: "Quelques informations suffisent pour accéder à l’assistant Zélo sur WhatsApp.",
      });
      return;
    }

    if (status.mode === "new_account" && status.stage === "account_pending") {
      configureVerification(true);
      showView("verification-view", {
        title: "Confirmer mon compte",
        description: "La dernière étape protège ton compte et ton panier.",
      });
      return;
    }

    if (status.mode === "new_account" && status.stage === "account_validated") {
      configureVerification(false);
      showView("verification-view", {
        title: "Terminer la connexion",
        description: "Ton adresse est confirmée. Finalise maintenant la liaison avec WhatsApp.",
      });
      return;
    }

    if (status.mode === "existing_account" && status.stage === "offered") {
      configureConnection(status.requiresEmail === true);
      showView("connection-view", {
        title: "Connecter mon compte",
        description: "Ton compte Zélo existe déjà. Confirme simplement la connexion.",
      });
      return;
    }

    showFatalError();
  }

  function validateForm(form) {
    if (form.checkValidity()) return true;
    form.reportValidity();
    return false;
  }

  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.textContent = reveal ? "Masquer" : "Afficher";
      button.setAttribute("aria-pressed", String(reveal));
      button.setAttribute("aria-label", reveal ? "Masquer le mot de passe" : "Afficher le mot de passe");
    });
  });

  document.getElementById("registration-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!validateForm(form)) return;

    const data = new FormData(form);
    const passwordInput = form.elements.password;
    setBusy(form, true);
    statusMessage.textContent = "";
    statusMessage.classList.remove("is-success");

    try {
      const response = await postJson("/integrations/meta/whatsapp/onboarding/start", {
        token,
        firstname: String(data.get("firstname") || "").trim(),
        lastname: String(data.get("lastname") || "").trim(),
        email: String(data.get("email") || "").trim(),
        address: {
          street: String(data.get("street") || "").trim(),
          zip: String(data.get("zip") || "").trim(),
          city: String(data.get("city") || "").trim(),
          country: String(data.get("country") || "").trim(),
        },
        regionId: String(data.get("regionId") || "").trim(),
        password: String(data.get("password") || ""),
        termsAccepted: data.get("termsAccepted") === "on",
      });

      passwordInput.value = "";
      if (response.stage !== "account_pending") throw new Error("unexpected_stage");
      showView("verification-view", {
        title: "Confirmer mon compte",
        description: "Consulte ta boîte de réception pour terminer l’inscription.",
      });
    } catch (error) {
      passwordInput.value = "";
      showFormError(
        error.message === "request_failed"
          ? "Nous n’avons pas pu poursuivre l’inscription. Vérifie les informations et réessaie."
          : error.message
      );
    } finally {
      setBusy(form, false);
    }
  });

  document.getElementById("verification-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!validateForm(form)) return;

    const data = new FormData(form);
    const passwordInput = form.elements.password;
    setBusy(form, true);
    statusMessage.textContent = "";

    try {
      const response = await postJson("/integrations/meta/whatsapp/onboarding/complete", {
        token,
        emailCode: String(data.get("emailCode") || "").trim(),
        password: String(data.get("password") || ""),
      });

      passwordInput.value = "";
      form.elements.emailCode.value = "";
      if (response.stage !== "completed") throw new Error("request_failed");
      showSuccess();
    } catch (error) {
      passwordInput.value = "";
      showFormError(
        error.message === "request_failed"
          ? "La confirmation n’a pas abouti. Vérifie le code et le mot de passe, puis réessaie."
          : error.message
      );
    } finally {
      setBusy(form, false);
    }
  });

  document.getElementById("connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!validateForm(form)) return;

    const data = new FormData(form);
    const passwordInput = form.elements.password;
    const emailRequired = form.elements.email.required;
    setBusy(form, true);
    statusMessage.textContent = "";

    try {
      const response = await postJson("/integrations/meta/whatsapp/onboarding/connect", {
        token,
        email: String(data.get("email") || "").trim(),
        password: String(data.get("password") || ""),
      });

      passwordInput.value = "";
      form.elements.email.value = "";
      if (response.stage !== "completed") throw new Error("request_failed");
      showSuccess();
    } catch (error) {
      passwordInput.value = "";
      showFormError(
        error.message === "request_failed"
          ? emailRequired
            ? "La connexion n’a pas abouti. Vérifie ton adresse électronique et ton mot de passe, puis réessaie."
            : "La connexion n’a pas abouti. Vérifie ton mot de passe et réessaie."
          : error.message
      );
    } finally {
      setBusy(form, false);
    }
  });

  document.getElementById("resend-code-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    statusMessage.textContent = "";
    try {
      await postJson("/integrations/meta/whatsapp/onboarding/resend", { token });
      statusMessage.textContent = "Un nouveau code vient d’être envoyé à ton adresse électronique.";
      statusMessage.classList.add("is-success");
    } catch (error) {
      statusMessage.classList.remove("is-success");
      showFormError(error.message || "Le code n’a pas pu être renvoyé.");
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("retry-button").addEventListener("click", () => {
    showView("loading-view", {
      title: "Vérification du lien",
      description: "Nous reprenons la connexion sécurisée.",
      focus: false,
    });
    initialize();
  });

  async function initialize() {
    if (!token || token.length > 2048) {
      showFatalError();
      return;
    }

    try {
      const status = await postJson("/integrations/meta/whatsapp/onboarding/status", { token });
      await showStage(status);
    } catch (error) {
      if (error.code === "invalid_or_expired_link") {
        clearTokenState();
        showFatalError();
        return;
      }
      showFatalError({
        title: "Service momentanément indisponible",
        description: "Ton lien est conservé dans cette page.",
        message: error.message || "Réessaie dans quelques instants.",
        retry: true,
      });
    }
  }

  initialize();
})();
