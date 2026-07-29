// Operator data for the legal pages (Impressum, Datenschutzerklärung,
// Nutzungsbedingungen).
//
// FILL THIS IN BEFORE LAUNCH. The footer links and the pages only render
// once name, address and email are set — until then the app behaves as if
// the pages did not exist, so an empty template is never publicly visible.
//
// §5 DDG requires: full name, postal address (no P.O. box), email plus one
// further fast contact channel (phone or contact form).

export const legalConfig = {
  operator: {
    // Full name of the responsible person or company, e.g. 'Max Mustermann'
    name: 'Justus Spott',
    // Street + number, postal code + city, country — use \n for line breaks
    address: 'Tiergartenstraße 38\n40237 Düsseldorf\nDeutschland',
    // Contact email shown on all three pages (self-hosted inbound,
    // verified working 2026-07-29 — Maildir at backend/mail-in/data/)
    email: 'kontakt@intellacc.com',
    // Optional but recommended as the second contact channel
    phone: ''
  },
  // Date shown as "Stand" on the Datenschutzerklärung and Nutzungsbedingungen
  lastUpdated: '2026-07-28'
};

export const legalReady = () => {
  const { name, address, email } = legalConfig.operator;
  return Boolean(name && address && email);
};
