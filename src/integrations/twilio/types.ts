export type TwilioInboundWhatsAppMessage = {
  body: string;
  from: string;
  to: string;
  messageSid?: string;
  profileName?: string;
  numMedia?: number;
};
