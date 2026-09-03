import { ArrowLeft, Check, Settings } from "lucide-react";

export type AppTheme = "light" | "dark";
export type AppPalette = "teal" | "blue" | "violet" | "orange" | "rose" | "green" | "mono";
export type AppFont = "misans" | "yahei" | "system";
export type CodeFont = "consolas" | "cascadia" | "source-code" | "system-mono";

type SettingsPageProps = {
  theme: AppTheme;
  palette: AppPalette;
  accentLightness: number;
  uiFont: AppFont;
  codeFont: CodeFont;
  uiFontSize: number;
  codeFontSize: number;
  layoutScale: number;
  taskHudGlass: boolean;
  onThemeChange: (value: AppTheme) => void;
  onPaletteChange: (value: AppPalette) => void;
  onAccentLightnessChange: (value: number) => void;
  onUiFontChange: (value: AppFont) => void;
  onCodeFontChange: (value: CodeFont) => void;
  onUiFontSizeChange: (value: number) => void;
  onCodeFontSizeChange: (value: number) => void;
  onLayoutScaleChange: (value: number) => void;
  onTaskHudGlassChange: (value: boolean) => void;
  onBack: () => void;
};

function Choice<T extends string>({
  value,
  current,
  label,
  onChange,
}: {
  value: T;
  current: T;
  label: string;
  onChange: (value: T) => void;
}) {
  const selected = value === current;
  return (
    <button className={`settings-choice ${selected ? "is-selected" : ""}`} type="button" onClick={() => onChange(value)} aria-pressed={selected}>
      <span>{label}</span>
      {selected && <Check size={15} aria-hidden="true" />}
    </button>
  );
}

const paletteChoices: Array<{ value: AppPalette; label: string; color: string }> = [
  { value: "teal", label: "青绿", color: "#0f766e" },
  { value: "blue", label: "蓝色", color: "#2563eb" },
  { value: "violet", label: "紫色", color: "#7c3aed" },
  { value: "orange", label: "橙色", color: "#c2410c" },
  { value: "rose", label: "玫红", color: "#be123c" },
  { value: "green", label: "绿色", color: "#15803d" },
  { value: "mono", label: "黑白", color: "#242421" },
];

export function SettingsPage({ theme, palette, accentLightness, uiFont, codeFont, uiFontSize, codeFontSize, layoutScale, taskHudGlass, onThemeChange, onPaletteChange, onAccentLightnessChange, onUiFontChange, onCodeFontChange, onUiFontSizeChange, onCodeFontSizeChange, onLayoutScaleChange, onTaskHudGlassChange, onBack }: SettingsPageProps) {
  return (
    <main className="settings-page">
      <header className="settings-header">
        <button className="icon-button" type="button" title="返回工作区" aria-label="返回工作区" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="settings-title"><Settings size={18} /><div><span className="eyebrow">Buffeed</span><h1>外观设置</h1></div></div>
      </header>
      <div className="settings-body">
        <section className="settings-section">
          <h2>主题</h2>
          <div className="settings-choice-grid">
            <Choice value="light" current={theme} label="浅色" onChange={onThemeChange} />
            <Choice value="dark" current={theme} label="深色" onChange={onThemeChange} />
          </div>
        </section>
        <section className="settings-section">
          <h2>调色板</h2>
          <div className="settings-palette-grid" role="radiogroup" aria-label="强调色">
            {paletteChoices.map((choice) => (
              <button
                key={choice.value}
                className={`settings-palette-swatch ${palette === choice.value ? "is-selected" : ""}`}
                type="button"
                title={choice.label}
                aria-label={choice.label}
                aria-pressed={palette === choice.value}
                onClick={() => onPaletteChange(choice.value)}
              >
                <span style={{ background: choice.color }} />
              </button>
            ))}
          </div>
          <label className="settings-range-label" htmlFor="accent-lightness">颜色深浅 <output>{accentLightness}%</output></label>
          <input id="accent-lightness" className="settings-range" type="range" min="30" max="72" value={accentLightness} onChange={(event) => onAccentLightnessChange(Number(event.target.value))} />
        </section>
        <section className="settings-section">
          <h2>界面字体</h2>
          <div className="settings-choice-grid">
            <Choice value="misans" current={uiFont} label="MiSans" onChange={onUiFontChange} />
            <Choice value="yahei" current={uiFont} label="微软雅黑" onChange={onUiFontChange} />
            <Choice value="system" current={uiFont} label="系统默认" onChange={onUiFontChange} />
          </div>
        </section>
        <section className="settings-section">
          <h2>代码字体</h2>
          <div className="settings-choice-grid">
            <Choice value="consolas" current={codeFont} label="Consolas" onChange={onCodeFontChange} />
            <Choice value="cascadia" current={codeFont} label="Cascadia Mono" onChange={onCodeFontChange} />
            <Choice value="source-code" current={codeFont} label="Source Code Pro" onChange={onCodeFontChange} />
            <Choice value="system-mono" current={codeFont} label="系统等宽" onChange={onCodeFontChange} />
          </div>
          <p className="settings-note">字体未安装时会自动使用系统回退字体。</p>
        </section>
        <section className="settings-section">
          <h2>字号</h2>
          <label className="settings-number-row" htmlFor="ui-font-size">
            <span><strong>UI 字号</strong><small>调整界面使用的基础字号</small></span>
            <span className="settings-number-control"><input id="ui-font-size" type="number" min="12" max="20" step="1" value={uiFontSize} onChange={(event) => onUiFontSizeChange(Math.min(20, Math.max(12, Number(event.target.value) || 14)))} /><em>px</em></span>
          </label>
          <label className="settings-number-row" htmlFor="code-font-size">
            <span><strong>代码字号</strong><small>调整代码、终端和差异视图字号</small></span>
            <span className="settings-number-control"><input id="code-font-size" type="number" min="10" max="18" step="1" value={codeFontSize} onChange={(event) => onCodeFontSizeChange(Math.min(18, Math.max(10, Number(event.target.value) || 12)))} /><em>px</em></span>
          </label>
        </section>
        <section className="settings-section">
          <h2>布局大小</h2>
          <label className="settings-range-label" htmlFor="layout-scale">控件与工作区（100% 为标准大小） <output>{layoutScale}%</output></label>
          <input id="layout-scale" className="settings-range" type="range" min="80" max="120" step="5" value={layoutScale} onChange={(event) => onLayoutScaleChange(Math.min(120, Math.max(80, Number(event.target.value) || 100)))} />
          <p className="settings-note">调整按钮、图标、输入框和工作区目录等布局尺寸。</p>
        </section>
        <section className="settings-section">
          <h2>任务条</h2>
          <button className={`settings-choice settings-toggle ${taskHudGlass ? "is-selected" : ""}`} type="button" onClick={() => onTaskHudGlassChange(!taskHudGlass)} aria-pressed={taskHudGlass}>
            <span>透明玻璃效果</span>
            <span className={`settings-switch ${taskHudGlass ? "is-on" : ""}`} aria-hidden="true"><span /></span>
          </button>
          <p className="settings-note">关闭后使用不透明背景。</p>
        </section>
      </div>
    </main>
  );
}
