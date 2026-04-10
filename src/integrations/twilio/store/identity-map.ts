type TwilioWhatsAppLink = {
  from: string;
  userRef: string;
  linkedAt: string;
};

const TWILIO_WA_TO_USERREF = new Map<string, TwilioWhatsAppLink>();

export function linkTwilioWhatsAppUser(from: string, userRef: string) {
  const record: TwilioWhatsAppLink = {
    from,
    userRef,
    linkedAt: new Date().toISOString(),
  };
  TWILIO_WA_TO_USERREF.set(from, record);
  return record;
}

export function getTwilioWhatsAppLink(from: string) {
  return TWILIO_WA_TO_USERREF.get(from);
}

export function resolveTwilioWhatsAppUserRef(from: string) {
  return getTwilioWhatsAppLink(from)?.userRef ?? `wa:${from.replace(/^whatsapp:/, "")}`;
}
