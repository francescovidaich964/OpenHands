import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSwitch } from "#/components/features/settings/settings-switch";
import { I18nKey } from "#/i18n/declaration";
import {
  getSpaceSummaryBridge,
  type SpaceSummarySettings,
} from "#/utils/space-summary-bridge";

/** Placeholder for the model field: a Claude model id, so never translated. */
const MODEL_PLACEHOLDER = "opus";

/**
 * Space summariser settings (fork feature): on/off plus the Claude model the
 * headless summariser runs (`opus` = latest Opus). There is no API-key field on
 * purpose: the summariser reuses the Claude Code login the user already has.
 *
 * The values live with the main process (next to the digests it writes), so this
 * card talks to the preload bridge instead of the settings mutation, and it
 * renders nothing in a browser tab where no process may be spawned.
 */
export function SpaceSummarySettings() {
  const { t } = useTranslation("openhands");
  const [settings, setSettings] = useState<SpaceSummarySettings | null>(null);
  const [modelDraft, setModelDraft] = useState("");

  useEffect(() => {
    const bridge = getSpaceSummaryBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.settings().then((result) => {
      if (cancelled || !result.ok || !result.settings) return;
      setSettings(result.settings);
      setModelDraft(result.settings.model);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings) return null;

  const write = (patch: Partial<SpaceSummarySettings>) => {
    const bridge = getSpaceSummaryBridge();
    if (!bridge) return;
    setSettings((current) => (current ? { ...current, ...patch } : current));
    void bridge.setSettings(patch).then((result) => {
      if (result.ok && result.settings) {
        setSettings(result.settings);
        setModelDraft(result.settings.model);
      }
    });
  };

  return (
    <div
      className="border-t border-border pt-6 mt-2"
      data-testid="space-summary-settings"
    >
      <h3 className="text-lg font-medium mb-2">{t(I18nKey.SPACE$TITLE)}</h3>
      <p className="mb-4 text-sm leading-5 text-tertiary-light">
        {t(I18nKey.SPACE$SETTINGS_DESCRIPTION)}
      </p>

      <SettingsSwitch
        testId="space-summaries-switch"
        isToggled={settings.enabled}
        onToggle={(isToggled) => write({ enabled: isToggled })}
      >
        {t(I18nKey.SPACE$SETTINGS_ENABLED)}
      </SettingsSwitch>

      <label
        className="mt-4 block text-sm text-tertiary"
        htmlFor="space-summary-model"
      >
        {t(I18nKey.SPACE$SETTINGS_MODEL)}
      </label>
      <input
        id="space-summary-model"
        data-testid="space-summary-model-input"
        className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm text-contrast outline-none focus-visible:ring-1 focus-visible:ring-border"
        value={modelDraft}
        placeholder={MODEL_PLACEHOLDER}
        onChange={(event) => setModelDraft(event.target.value)}
        onBlur={() => {
          const next = modelDraft.trim();
          if (next !== "" && next !== settings.model) write({ model: next });
          else setModelDraft(settings.model);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const next = modelDraft.trim();
          if (next !== "") write({ model: next });
        }}
      />
      <p className="mt-2 text-xs leading-4 text-text-dim">
        {t(I18nKey.SPACE$SETTINGS_MODEL_HINT)}
      </p>
    </div>
  );
}
