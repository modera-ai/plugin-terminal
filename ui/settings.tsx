import { useEffect, useRef, useState } from "react";
import {
  Button,
  Field,
  frontend,
  SettingsCard,
  SettingsPage,
} from "@modera/plugin-sdk/react";
import { settingsAction, useSettings } from "./use-settings";

interface Detection {
  shells: { id: string; label: string; path: string }[];
  distributions: string[];
}

function ShellPicker({
  value,
  shells,
  zh,
  onChange,
}: {
  value: string;
  shells: Detection["shells"];
  zh: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = shells.find(
    (item) => item.path.toLowerCase() === value.toLowerCase(),
  );
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const choose = (next: string) => {
    setOpen(false);
    onChange(next);
  };
  return (
    <div ref={root} className="shell-picker">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="shell-picker__trigger"
      >
        <span>
          <span style={{ display: "block" }}>
            {value === "auto"
              ? zh
                ? "留空则自动检测"
                : "Leave empty to auto detect"
              : selected?.label || (zh ? "自定义 Shell" : "Custom shell")}
          </span>
          {value !== "auto" && <small>{value}</small>}
        </span>
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
          <path d="m5.5 7.5 4.5 4 4.5-4" />
        </svg>
      </button>
      {open && (
        <div role="listbox" className="shell-picker__menu">
          <button
            type="button"
            role="option"
            aria-selected={value === "auto"}
            onClick={(event) => {
              event.stopPropagation();
              choose("auto");
            }}
            className="shell-picker__option"
            data-selected={value === "auto" || undefined}
          >
            {zh ? "留空则自动检测" : "Leave empty to auto detect"}
          </button>
          {shells.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.path === value}
              key={item.path}
              onClick={(event) => {
                event.stopPropagation();
                choose(item.path);
              }}
              className="shell-picker__option"
              data-selected={item.path === value || undefined}
            >
              <span>{item.label}</span>
              <small>{item.path}</small>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void frontend()
                .settings.pickFile()
                .then((path) => path && choose(path));
            }}
            className="shell-picker__option shell-picker__browse"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
              <path d="M2.75 6.5h14.5v8.25a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V6.5Z" />
              <path d="M2.75 7V5.25a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.75h7a1.5 1.5 0 0 1 1.5 1.5" />
            </svg>
            {zh ? "浏览" : "Browse"}
          </button>
        </div>
      )}
    </div>
  );
}

function TerminalSettings() {
  const settings = useSettings({ autoSave: true });
  const [detected, setDetected] = useState<Detection>({
    shells: [],
    distributions: [],
  });
  useEffect(() => {
    void settings.run(async () =>
      setDetected(await settingsAction<Detection>("detect")),
    );
  }, []);
  if (!settings.config)
    return (
      <SettingsPage title={settings.zh ? "终端设置" : "Terminal settings"}>
        <p>{settings.error || (settings.zh ? "正在加载…" : "Loading…")}</p>
      </SettingsPage>
    );
  const value = (key: string) => settings.values[key];
  const set = (key: string, next: string | number | boolean) =>
    settings.setValues((current) => ({ ...current, [key]: next }));
  const integratedShell = String(value("integratedShell"));
  return (
    <SettingsPage title={settings.zh ? "终端设置" : "Terminal settings"}>
      <p className="df-description">
        {settings.zh
          ? "分别配置智能体命令的运行环境和侧边栏集成终端。Shell 修改后，已打开的集成终端会自动刷新。"
          : "Configure the agent command environment and sidebar terminal independently. Open terminals refresh after the shell changes."}
      </p>
      <SettingsCard title={settings.zh ? "智能体环境" : "Agent environment"}>
        <p>
          {settings.zh
            ? "选择智能体在 Windows 上执行终端命令的位置。"
            : "Choose where agent terminal commands run on Windows."}
        </p>
        <Field label={settings.zh ? "运行位置" : "Run commands in"}>
          <select
            value={String(value("agentEnvironment"))}
            onChange={(event) => set("agentEnvironment", event.target.value)}
          >
            <option value="windows-native">
              Windows {settings.zh ? "原生" : "native"}
            </option>
            <option value="wsl">Windows Subsystem for Linux (WSL2)</option>
          </select>
        </Field>
        {value("agentEnvironment") === "wsl" && (
          <Field label={settings.zh ? "WSL 发行版" : "WSL distribution"}>
            <select
              value={String(value("wslDistribution"))}
              onChange={(event) => set("wslDistribution", event.target.value)}
            >
              <option value="">
                {settings.zh ? "系统默认" : "System default"}
              </option>
              {detected.distributions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
        )}
      </SettingsCard>
      <SettingsCard title={settings.zh ? "集成终端" : "Integrated terminal"}>
        <p>
          {settings.zh
            ? "选择侧边栏中新终端使用的 Shell。它不会改变智能体环境。"
            : "Choose the shell for new sidebar terminals. This does not change the agent environment."}
        </p>
        <Field
          label={settings.zh ? "集成终端 Shell" : "Integrated terminal shell"}
        >
          <ShellPicker
            value={integratedShell}
            shells={detected.shells}
            zh={settings.zh}
            onChange={(next) => set("integratedShell", next)}
          />
        </Field>
        <Field label={settings.zh ? "字体" : "Font family"}>
          <input
            value={String(value("fontFamily"))}
            onChange={(event) => set("fontFamily", event.target.value)}
          />
        </Field>
        <div className="df-grid">
          <Field label={settings.zh ? "字号" : "Font size"}>
            <input
              type="number"
              min={6}
              max={72}
              value={Number(value("fontSize"))}
              onChange={(event) => set("fontSize", Number(event.target.value))}
            />
          </Field>
          <Field label={settings.zh ? "行高" : "Line height"}>
            <input
              type="number"
              min={0.5}
              max={3}
              step={0.1}
              value={Number(value("lineHeight"))}
              onChange={(event) =>
                set("lineHeight", Number(event.target.value))
              }
            />
          </Field>
        </div>
        <label className="df-check">
          <input
            className="df-switch"
            type="checkbox"
            checked={Boolean(value("gpuRendering"))}
            onChange={(event) => set("gpuRendering", event.target.checked)}
          />
          {settings.zh ? "启用 GPU 渲染" : "Enable GPU rendering"}
        </label>
      </SettingsCard>
      {settings.message && (
        <p
          role={settings.failed ? "alert" : "status"}
          style={{ color: settings.failed ? "#b42318" : undefined }}
        >
          {settings.message}
        </p>
      )}
    </SettingsPage>
  );
}
import { mountPlugin } from "@modera/plugin-sdk/react";
mountPlugin(<TerminalSettings />);
