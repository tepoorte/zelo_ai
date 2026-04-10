export type WhatsAppInboundTextMessage = {
  channel: "whatsapp";
  userId: string;
  text: string;
  messageId?: string;
  fromName?: string;
};

export type WhatsAppOutboundTextMessage = {
  to: string;
  body: string;
  previewUrl?: boolean;
  replyToMessageId?: string;
};

export type WhatsAppWebhookVerification = {
  mode?: string;
  verifyToken?: string;
  challenge?: string;
};

export type WhatsAppLinkRecord = {
  waId: string;
  userRef: string;
  linkedAt: string;
};
