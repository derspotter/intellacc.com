import Section from './settings/Section';
import SkinSection from './settings/SkinSection';
import FeedMixSection from './settings/FeedMixSection';
import TopicsSection from './settings/TopicsSection';
import NotificationsSection from './settings/NotificationsSection';
import VerificationSection from './settings/VerificationSection';
import ApiKeysSection from './settings/ApiKeysSection';
import PasskeysSection from './settings/PasskeysSection';
import VaultSection from './settings/VaultSection';
import DevicesSection from './settings/DevicesSection';
import DangerZoneSection from './settings/DangerZoneSection';

export default function SettingsView() {
  return (
    <div class="font-mono text-sm p-px columns-1 md:columns-2 xl:columns-3 gap-px">
      <Section title="SKIN" code="SET·01"><SkinSection /></Section>
      <Section title="FEED MIX" code="SET·02"><FeedMixSection /></Section>
      <Section title="TOPICS" code="SET·03"><TopicsSection /></Section>
      <Section title="NOTIFICATIONS" code="SET·04"><NotificationsSection /></Section>
      <Section title="VERIFICATION" code="SET·05"><VerificationSection /></Section>
      <Section title="API KEYS" code="SET·06"><ApiKeysSection /></Section>
      <Section title="PASSKEYS" code="SET·07"><PasskeysSection /></Section>
      <Section title="VAULT" code="SET·08"><VaultSection /></Section>
      <Section title="DEVICES" code="SET·09"><DevicesSection /></Section>
      <Section title="DANGER ZONE" code="SET·10" tone="danger"><DangerZoneSection /></Section>
    </div>
  );
}
