import { useEffect, useState } from "react";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import {
  Button,
  DialogNotice,
  Input,
  Select,
  Switch,
  UiProvider,
} from "@pal/ui";
import {
  FieldRow,
  Form,
  FormItem,
  SettingsColumns,
  SettingsPage,
  SettingsPanel,
} from "@pal/ui/settings";
import "@pal/ui/styles.css";
import { mountPlugin, useSettings } from "@pal/plugin-sdk/react";
import { pal } from "@pal/plugin-sdk";

interface Detection {
  shells: { id: string; label: string; path: string }[];
  distributions: string[];
}

function TerminalSettings() {
  const settings = useSettings({ autoSave: true });
  const [detected, setDetected] = useState<Detection>({
    shells: [],
    distributions: [],
  });
  useEffect(() => {
    void pal
      .ready()
      .catch(() => {});
    void settings.run(async () =>
      setDetected(
        await pal.command.execute<Detection>(
          "pal.terminal.detect",
          {},
        ),
      ),
    );
  }, []);
  const t = (zh: string, en: string) => (settings.zh ? zh : en);
  const value = (key: string) => settings.values[key];
  const set = (key: string, next: string | number | boolean) =>
    settings.setValues((current) => ({ ...current, [key]: next }));
  const shell = String(value("integratedShell") ?? "auto");
  const shellOptions = [
    { value: "auto", label: t("自动检测", "Auto detect") },
    ...detected.shells.map((item) => ({
      value: item.path,
      label: item.label,
      description: item.path,
    })),
  ];
  if (shell !== "auto" && !shellOptions.some((item) => item.value === shell))
    shellOptions.push({
      value: shell,
      label: t("自定义 Shell", "Custom shell"),
      description: shell,
    });
  const browse = () =>
    void settings.run(async () => {
      const path = await pal.settings.pickFile();
      if (path) set("integratedShell", path);
    });
  const number = (key: string, raw: string) => {
    if (raw !== "" && Number.isFinite(Number(raw))) set(key, Number(raw));
  };
  return (
    <UiProvider
      theme={settings.snapshot?.theme?.mode ?? "system"}
      locale={settings.zh ? "zh-CN" : "en"}
      className="terminal-settings-ui mu-settings-codex"
    >
      <SettingsPage
        title={t("终端设置", "Terminal settings")}
        description={t(
          "分别配置智能体命令的运行环境和侧边栏集成终端。Shell 修改后，已打开的集成终端会自动刷新。",
          "Configure the agent command environment and sidebar terminal independently. Open terminals refresh after the shell changes.",
        )}
        actions={
          <span
            className="settings-save-feedback"
            role="status"
            aria-live="polite"
          >
            {settings.failed || settings.error ? "" : settings.message}
          </span>
        }
      >
        {!settings.config ? (
          <DialogNotice tone={settings.error ? "error" : "default"}>
            {settings.error || t("正在加载…", "Loading…")}
          </DialogNotice>
        ) : (
          <SettingsColumns columns={1}>
            <SettingsPanel title={t("智能体环境", "Agent environment")}>
              <Form>
                <FormItem
                  variant="inline"
                  label={t("运行位置", "Run commands in")}
                  description={t(
                    "选择智能体在 Windows 上执行终端命令的位置。",
                    "Choose where agent terminal commands run on Windows.",
                  )}
                >
                  <Select
                    label={t("运行位置", "Run commands in")}
                    value={String(value("agentEnvironment"))}
                    onValueChange={(next) => set("agentEnvironment", next)}
                    options={[
                      {
                        value: "windows-native",
                        label: t("Windows 原生", "Windows native"),
                      },
                      {
                        value: "wsl",
                        label: "Windows Subsystem for Linux (WSL2)",
                      },
                    ]}
                  />
                </FormItem>
                {value("agentEnvironment") === "wsl" && (
                  <FormItem
                    variant="inline"
                    label={t("WSL 发行版", "WSL distribution")}
                  >
                    <Select
                      label={t("WSL 发行版", "WSL distribution")}
                      value={String(value("wslDistribution") || "default")}
                      onValueChange={(next) =>
                        set("wslDistribution", next === "default" ? "" : next)
                      }
                      options={[
                        {
                          value: "default",
                          label: t("系统默认", "System default"),
                        },
                        ...detected.distributions.map((item) => ({
                          value: item,
                          label: item,
                        })),
                      ]}
                    />
                  </FormItem>
                )}
              </Form>
            </SettingsPanel>
            <SettingsPanel title={t("集成终端", "Integrated terminal")}>
              <Form columns={2}>
                <FormItem
                  variant="inline"
                  className="settings-path-row"
                  label={t("集成终端 Shell", "Integrated terminal shell")}
                  description={t(
                    "选择侧边栏中新终端使用的 Shell。它不会改变智能体环境。",
                    "Choose the shell for new sidebar terminals. This does not change the agent environment.",
                  )}
                  span="full"
                >
                  <FieldRow>
                    <Select
                      label={t("集成终端 Shell", "Integrated terminal shell")}
                      value={shell}
                      onValueChange={(next) => set("integratedShell", next)}
                      options={shellOptions}
                    />
                    <Button
                      variant="outline"
                      disabled={settings.busy}
                      onClick={browse}
                    >
                      <FolderOpen size={14} />
                      {t("浏览", "Browse")}
                    </Button>
                  </FieldRow>
                </FormItem>
                <FormItem
                  variant="inline"
                  label={t("字体", "Font family")}
                  span="full"
                >
                  <Input
                    label={t("字体", "Font family")}
                    hideLabel
                    value={String(value("fontFamily"))}
                    onChange={(next) => set("fontFamily", next)}
                  />
                </FormItem>
                <FormItem variant="inline" label={t("字号", "Font size")}>
                  <Input
                    label={t("字号", "Font size")}
                    hideLabel
                    type="number"
                    min={6}
                    max={72}
                    unit="px"
                    unitWidth="full"
                    value={Number(value("fontSize"))}
                    onChange={(next) => number("fontSize", next)}
                  />
                </FormItem>
                <FormItem variant="inline" label={t("行高", "Line height")}>
                  <Input
                    label={t("行高", "Line height")}
                    hideLabel
                    type="number"
                    min={0.5}
                    max={3}
                    step={0.1}
                    value={Number(value("lineHeight"))}
                    onChange={(next) => number("lineHeight", next)}
                  />
                </FormItem>
                <FormItem
                  variant="inline"
                  span="full"
                  label={t("启用 GPU 渲染", "Enable GPU rendering")}
                >
                  <Switch
                    label={t("启用 GPU 渲染", "Enable GPU rendering")}
                    checked={Boolean(value("gpuRendering"))}
                    onCheckedChange={(next) => set("gpuRendering", next)}
                  />
                </FormItem>
              </Form>
            </SettingsPanel>
          </SettingsColumns>
        )}
        {(settings.failed || settings.error) && (
          <DialogNotice tone={settings.failed ? "error" : "default"}>
            {settings.error || settings.message}
          </DialogNotice>
        )}
      </SettingsPage>
    </UiProvider>
  );
}
mountPlugin(<TerminalSettings />);
