import axios from "axios";
import { env } from "../config/env.js";

export const swissdata = axios.create({
  baseURL: env.swissdataBaseUrl,
  timeout: 15000,
  headers: {
    "x-api-key": env.swissdataApiKey,
    ...(env.swissdataAppId ? { "x-app-id": env.swissdataAppId } : {})
  }
});