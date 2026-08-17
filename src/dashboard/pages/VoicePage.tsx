import { useNavigate } from "react-router-dom";
import { VoicePickerCards } from "../../voice/VoicePickerCards";
import { SettingsPageLayout, SettingsSection } from "../components/SettingsPageLayout";

export function VoicePage() {
  const navigate = useNavigate();

  return (
    <SettingsPageLayout
      title="Buddy's voice"
      description="Choose how Buddy sounds. Your selection follows your account across desktop and mobile."
    >
      <SettingsSection
        title="Choose a voice"
        description="Tap play to hear one. Tap the card to keep it. Your pick starts with your next call."
      >
        <VoicePickerCards
          surface="settings"
          onLockedVoice={() => navigate("/billing")}
        />
      </SettingsSection>
    </SettingsPageLayout>
  );
}
