import { Show, For } from 'solid-js';
import { legalConfig, legalReady } from '../legal/legalConfig';

// Impressum / Datenschutzerklärung / Nutzungsbedingungen.
// German is the legally operative language for a German operator; the
// product UI staying English is fine, these pages are not.

const AddressBlock = () => (
  <p>
    {legalConfig.operator.name}
    <For each={(legalConfig.operator.address || '').split('\n')}>
      {(line) => (<><br />{line}</>)}
    </For>
    <br />E-Mail: {legalConfig.operator.email}
    <Show when={legalConfig.operator.phone}>
      <br />Telefon: {legalConfig.operator.phone}
    </Show>
  </p>
);

const Impressum = () => (
  <>
    <h1>Impressum</h1>
    <h2>Angaben gemäß § 5 DDG</h2>
    <AddressBlock />
    <h2>Verantwortlich für den Inhalt</h2>
    <p>{legalConfig.operator.name} (Anschrift wie oben)</p>
    <h2>Haftung für Inhalte</h2>
    <p>
      Die Inhalte dieser Plattform werden überwiegend von Nutzerinnen und
      Nutzern erstellt. Als Diensteanbieter sind wir gemäß § 7 Abs. 1 DDG für
      eigene Inhalte verantwortlich; zur Überwachung fremder Inhalte sind wir
      nicht allgemein verpflichtet (§§ 8–10 DDG). Bei Bekanntwerden von
      Rechtsverletzungen entfernen wir betroffene Inhalte umgehend — Hinweise
      bitte an die oben genannte E-Mail-Adresse.
    </p>
  </>
);

const Datenschutz = () => (
  <>
    <h1>Datenschutzerklärung</h1>
    <p>Stand: {legalConfig.lastUpdated}</p>

    <h2>1. Verantwortlicher</h2>
    <AddressBlock />

    <h2>2. Welche Daten wir verarbeiten</h2>
    <p>
      <strong>Kontodaten:</strong> Benutzername, E-Mail-Adresse, Passwort
      (als bcrypt-Hash). Optional: Anzeigename, Profiltext, Profilbild.
    </p>
    <p>
      <strong>Inhalte:</strong> Beiträge, Kommentare, Reaktionen sowie Ihre
      Handelspositionen und Prognosen auf Vorhersagemärkten (inkl. daraus
      berechneter Genauigkeits- und Reputationswerte, die anderen Nutzern
      angezeigt werden).
    </p>
    <p>
      <strong>Direktnachrichten:</strong> Nachrichten sind Ende-zu-Ende
      verschlüsselt (MLS-Protokoll). Wir können ihren Inhalt nicht lesen;
      auf unseren Servern liegen nur verschlüsselte Daten und technische
      Metadaten (Absender-/Empfängerkennung, Zeitpunkte).
    </p>
    <p>
      <strong>Technische Daten:</strong> IP-Adresse und Zugriffszeitpunkt in
      Server-Logs (zur Missbrauchsabwehr und Fehlerdiagnose, kurzfristige
      Speicherung). Es werden keine Tracking- oder Analyse-Dienste
      eingesetzt und keine Werbe-Cookies gesetzt; der Login-Status wird
      lokal in Ihrem Browser gespeichert.
    </p>

    <h2>3. Zwecke und Rechtsgrundlagen</h2>
    <p>
      Die Verarbeitung erfolgt zur Bereitstellung der Plattform
      (Art. 6 Abs. 1 lit. b DSGVO), zur Missbrauchs- und Betrugsabwehr
      (Art. 6 Abs. 1 lit. f DSGVO) sowie — soweit Sie einwilligen — zu den
      jeweils genannten Zwecken (Art. 6 Abs. 1 lit. a DSGVO).
    </p>

    <h2>4. Verifizierung über Zahlungsdienstleister</h2>
    <p>
      Für die optionale Konto-Verifizierung (Stufe 3) setzen wir Stripe
      (Stripe Payments Europe, Ltd., Irland) bzw. PayPal (PayPal (Europe)
      S.à r.l. et Cie, S.C.A., Luxemburg) ein. Dabei werden
      Zahlungsinstrument-Daten direkt beim jeweiligen Anbieter verarbeitet;
      wir erhalten und speichern keine vollständigen Zahlungsdaten. Es
      finden keine Käufe statt — die Plattformwährung (Reputationspunkte)
      kann weder gekauft noch ausgezahlt werden.
    </p>

    <h2>5. Hosting</h2>
    <p>
      Die Plattform wird auf eigenen Servern in Deutschland betrieben.
      E-Mails (z. B. Verifizierung, Passwort-Zurücksetzen) versenden wir
      über eigene Mailinfrastruktur.
    </p>

    <h2>6. Speicherdauer und Löschung</h2>
    <p>
      Kontodaten speichern wir bis zur Löschung des Kontos. Sie können Ihr
      Konto jederzeit in den Einstellungen löschen; dabei werden
      personenbezogene Angaben entfernt bzw. anonymisiert.
    </p>

    <h2>7. Ihre Rechte</h2>
    <p>
      Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung
      (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18),
      Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21) sowie das
      Recht auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde
      (Art. 77 DSGVO). Wenden Sie sich dazu an die oben genannte
      E-Mail-Adresse.
    </p>
  </>
);

const Terms = () => (
  <>
    <h1>Nutzungsbedingungen</h1>
    <p>Stand: {legalConfig.lastUpdated}</p>

    <h2>1. Geltungsbereich</h2>
    <p>
      Diese Bedingungen gelten für die Nutzung der Plattform Intellacc,
      betrieben von {legalConfig.operator.name} (siehe Impressum).
    </p>

    <h2>2. Reputationspunkte (RP)</h2>
    <p>
      Vorhersagemärkte auf Intellacc werden ausschließlich mit
      Reputationspunkten („RP") gespielt. RP sind eine virtuelle
      Spielwährung ohne Geldwert: Sie können nicht gekauft, nicht verkauft,
      nicht übertragen und nicht ausgezahlt werden. Die Teilnahme ist kein
      Glücksspiel und kein Finanzinstrument; ein Anspruch auf RP-Stände
      besteht nicht.
    </p>

    <h2>3. Marktauflösung</h2>
    <p>
      Vorhersagemärkte werden nach den in der jeweiligen Frage genannten
      Kriterien aufgelöst. Bei Unklarheiten entscheidet der Betreiber nach
      billigem Ermessen; offensichtliche Fehler können korrigiert werden.
    </p>

    <h2>4. Konto und Mindestalter</h2>
    <p>
      Für die Registrierung ist ein Mindestalter von 13 Jahren
      erforderlich. Nutzer unter 16 Jahren benötigen die Einwilligung
      eines Erziehungsberechtigten. Sie sind für die Sicherheit Ihrer
      Zugangsdaten verantwortlich. Der Betreiber kann Registrierungen
      ablehnen (Freischaltverfahren).
    </p>

    <h2>5. Inhalte und Verhalten</h2>
    <p>
      Unzulässig sind insbesondere: rechtswidrige Inhalte, Belästigung,
      Spam, Manipulation von Märkten (z. B. koordinierte Falschauflösung),
      automatisierter Missbrauch sowie Eingriffe in die technische
      Infrastruktur. Für Ihre Inhalte bleiben Sie verantwortlich; Sie
      räumen dem Betreiber das für den Betrieb erforderliche einfache
      Nutzungsrecht an geposteten Inhalten ein.
    </p>

    <h2>6. Moderation und Kündigung</h2>
    <p>
      Der Betreiber kann Inhalte entfernen und Konten bei Verstößen
      verwarnen, einschränken oder schließen. Sie können Ihr Konto
      jederzeit in den Einstellungen löschen.
    </p>

    <h2>7. Verfügbarkeit und Haftung</h2>
    <p>
      Die Plattform wird ohne Verfügbarkeitszusage im Beta-Betrieb
      bereitgestellt. Der Betreiber haftet unbeschränkt bei Vorsatz und
      grober Fahrlässigkeit; bei einfacher Fahrlässigkeit nur für die
      Verletzung wesentlicher Vertragspflichten und begrenzt auf den
      vorhersehbaren, vertragstypischen Schaden.
    </p>

    <h2>8. Schlussbestimmungen</h2>
    <p>
      Es gilt deutsches Recht. Änderungen dieser Bedingungen werden
      angemeldeten Nutzern rechtzeitig angekündigt.
    </p>
  </>
);

export default function LegalPage(props) {
  return (
    <section class="legal-page">
      <Show
        when={legalReady()}
        fallback={<p>Diese Seite wird derzeit vervollständigt.</p>}
      >
        <Show when={props.kind === 'impressum'}><Impressum /></Show>
        <Show when={props.kind === 'datenschutz'}><Datenschutz /></Show>
        <Show when={props.kind === 'terms'}><Terms /></Show>
      </Show>
    </section>
  );
}
