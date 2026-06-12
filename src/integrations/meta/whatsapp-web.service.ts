import fs from "node:fs/promises";
import path from "node:path";

import makeWASocket, {
  DisconnectReason,
  type WAMessage,
  type WASocket,
} from "baileys";
import { DEFAULT_CONNECTION_CONFIG } from "baileys/lib/Defaults/index.js";
import { useMultiFileAuthState } from "baileys/lib/Utils/use-multi-file-auth-state.js";
import qrcode from "qrcode-terminal";

import { env } from "../../config/env.js";
import type { WhatsAppInboundTextMessage } from "./types.js";
import { metaEnv } from "./env.js";
import { buildWhatsAppConversationReply } from "./whatsapp.service.js";
import { splitWhatsAppText } from "./whatsapp.send.js";
import { normalizeWhatsAppPhone } from "./whatsapp-session.service.js";

type WhatsAppWebConnection = "disabled" | "idle" | "connecting" | "open" | "close";

export type WhatsAppWebStatus = {
  enabled: boolean;
  started: boolean;
  connection: WhatsAppWebConnection;
  qr: string | null;
  sessionDir: string;
  user: string | null;
  lastError: string | null;
};

let socket: WASocket | null = null;
let startPromise: Promise<WhatsAppWebStatus> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

const status: WhatsAppWebStatus = {
  enabled: metaEnv.whatsappProvider === "web_session",
  started: false,
  connection: metaEnv.whatsappProvider === "web_session" ? "idle" : "disabled",
  qr: null,
  sessionDir: metaEnv.whatsappSessionDir,
  user: null,
  lastError: null,
};

function resolveSessionDir(): string {
  return path.isAbsolute(metaEnv.whatsappSessionDir)
    ? metaEnv.whatsappSessionDir
    : path.join(process.cwd(), metaEnv.whatsappSessionDir);
}

function isPrivateChatJid(jid?: string | null): jid is string {
  return Boolean(jid && jid.endsWith("@s.whatsapp.net"));
}

function extractTextFromBaileysMessage(message: WAMessage["message"]): string {
  let current: any = message;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    break;
  }

  return String(
    current?.conversation ||
      current?.extendedTextMessage?.text ||
      current?.imageMessage?.caption ||
      current?.videoMessage?.caption ||
      current?.documentMessage?.caption ||
      ""
  ).trim();
}

export function parseBaileysInboundTextMessage(message: WAMessage): WhatsAppInboundTextMessage | null {
  if (message.key.fromMe) {
    return null;
  }

  const jid = message.key.remoteJid;
  if (!isPrivateChatJid(jid)) {
    return null;
  }

  const text = extractTextFromBaileysMessage(message.message);
  if (!text) {
    return {
      channel: "whatsapp",
      userId: normalizeWhatsAppPhone(jid),
      text: "",
      messageId: message.key.id ?? undefined,
      fromName: message.pushName ?? undefined,
    };
  }

  return {
    channel: "whatsapp",
    userId: normalizeWhatsAppPhone(jid),
    text,
    messageId: message.key.id ?? undefined,
    fromName: message.pushName ?? undefined,
  };
}

async function sendWhatsAppWebText(to: string, body: string) {
  if (!socket) {
    throw new Error("WhatsApp Web socket is not started");
  }

  const jid = to.includes("@") ? to : `${normalizeWhatsAppPhone(to)}@s.whatsapp.net`;
  await socket.sendMessage(jid, { text: body });
}

async function processBaileysMessage(message: WAMessage) {
  const inbound = parseBaileysInboundTextMessage(message);
  if (!inbound) return;

  const jid = message.key.remoteJid;
  if (!jid) return;

  if (!inbound.text) {
    await sendWhatsAppWebText(jid, "Je peux t’aider avec les messages texte pour le moment.");
    return;
  }

  const reply = await buildWhatsAppConversationReply(inbound);
  const parts = splitWhatsAppText(reply.message);
  for (const part of parts) {
    await sendWhatsAppWebText(jid, part);
  }
}

function scheduleReconnect() {
  if (reconnectTimer || metaEnv.whatsappProvider !== "web_session") {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startWhatsAppWebSession().catch((error) => {
      status.lastError = error instanceof Error ? error.message : String(error);
      console.error("[whatsapp-web] reconnect failed", error);
    });
  }, 5000);
}

export async function startWhatsAppWebSession(): Promise<WhatsAppWebStatus> {
  status.enabled = metaEnv.whatsappProvider === "web_session";
  status.sessionDir = metaEnv.whatsappSessionDir;

  if (!status.enabled) {
    status.connection = "disabled";
    return getWhatsAppWebStatus();
  }

  if (socket && status.connection !== "close") {
    return getWhatsAppWebStatus();
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    status.started = true;
    status.connection = "connecting";
    status.lastError = null;

    await fs.mkdir(resolveSessionDir(), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(resolveSessionDir());

    socket = makeWASocket({
      ...DEFAULT_CONNECTION_CONFIG,
      auth: state,
      browser: ["Zelo AI", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      if (update.qr) {
        status.qr = update.qr;
        qrcode.generate(update.qr, { small: true });
      }

      if (update.connection) {
        status.connection = update.connection as WhatsAppWebConnection;
      }

      if (update.lastDisconnect?.error) {
        status.lastError =
          update.lastDisconnect.error instanceof Error
            ? update.lastDisconnect.error.message
            : String(update.lastDisconnect.error);
      }

      if (update.connection === "open") {
        status.qr = null;
        status.user = socket?.user?.id ?? null;
      }

      if (update.connection === "close") {
        const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
        socket = null;
        if (statusCode !== DisconnectReason.loggedOut) {
          scheduleReconnect();
        }
      }
    });

    socket.ev.on("messages.upsert", (event) => {
      for (const message of event.messages) {
        void processBaileysMessage(message).catch((error) => {
          status.lastError = error instanceof Error ? error.message : String(error);
          console.error("[whatsapp-web] message processing error", error);
        });
      }
    });

    return getWhatsAppWebStatus();
  })().finally(() => {
    startPromise = null;
  });

  return startPromise;
}

export function getWhatsAppWebStatus(): WhatsAppWebStatus {
  return { ...status };
}

export function renderWhatsAppWebQrTerminal(qr: string): string {
  let output = "";
  qrcode.generate(qr, { small: true }, (rendered) => {
    output = rendered;
  });
  return output;
}

export async function sendWhatsAppWebTestMessage(to: string, text: string) {
  await startWhatsAppWebSession();
  await sendWhatsAppWebText(to, text);
}
