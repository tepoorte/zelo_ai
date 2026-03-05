import axios from "axios";
import { env } from "../config/env.js";
import { getStoredToken } from "./auth.js";

export function swissdataClient(userRef?: string) {
  const token = userRef ? getStoredToken(userRef) : undefined;

  return axios.create({
    baseURL: env.swissdataBaseUrl,      // es: http://host.docker.internal:3040
    timeout: 15000,
    params: {
      apiKey: env.swissdataApiKey,      // <-- QUESTO è fondamentale
    },
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}