export const PANEL_CSS = /* css */ `
:host {
  all: initial;
  --ibh-accent: #7c5cff;
  --ibh-bg: #14151a;
  --ibh-panel: #1b1d25;
  --ibh-panel-2: #22242e;
  --ibh-border: #2c2f3b;
  --ibh-text: #e8e9ef;
  --ibh-muted: #9aa0b2;
  --ibh-danger: #ff5c7a;
  --ibh-ok: #4cd97b;
  --ibh-warn: #ffc95c;
  --ibh-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
  --ibh-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --ibh-font-size: 14px;
  --ibh-width: 400px;
  --ibh-height: 560px;
  --ibh-radius: 10px;
  --ibh-radius-s: 6px;
  --ibh-radius-panel: 14px;
  font-family: var(--ibh-font);
  font-size: var(--ibh-font-size);
  line-height: 1.45;
  color: var(--ibh-text);
}

/* light theme (selected explicitly, or resolved from prefers-color-scheme) */
:host([data-ibh-theme='light']) {
  --ibh-accent: #6a4df6;
  --ibh-bg: #f2f3f8;
  --ibh-panel: #ffffff;
  --ibh-panel-2: #f4f5fb;
  --ibh-border: #dfe2ec;
  --ibh-text: #181a23;
  --ibh-muted: #636a7d;
  --ibh-danger: #d43f63;
  --ibh-ok: #17994e;
  --ibh-warn: #a97b08;
  --ibh-shadow: 0 12px 40px rgba(24, 30, 60, 0.18);
}
* { box-sizing: border-box; }
button { font: inherit; cursor: pointer; }

.launcher {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: var(--ibh-launcher-size, 48px);
  height: var(--ibh-launcher-size, 48px);
  border-radius: var(--ibh-launcher-radius, 50%);
  border: var(--ibh-launcher-border, none);
  background: var(--ibh-launcher-bg, linear-gradient(135deg, var(--ibh-accent), #b44cff));
  color: var(--ibh-launcher-color, #fff);
  font-weight: var(--ibh-launcher-font-weight, 700);
  font-size: var(--ibh-launcher-font-size, 15px);
  letter-spacing: 0.02em;
  box-shadow: var(--ibh-launcher-shadow, 0 6px 24px rgba(124, 92, 255, 0.45));
  z-index: 2147483000;
}
.launcher:hover { transform: translateY(-1px); }

.panel {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: min(var(--ibh-width), calc(100vw - 32px));
  height: min(var(--ibh-height), calc(100vh - 32px));
  display: flex;
  flex-direction: column;
  background: var(--ibh-panel);
  border: 1px solid var(--ibh-border);
  border-radius: var(--ibh-radius-panel);
  box-shadow: var(--ibh-shadow);
  overflow: hidden;
  z-index: 2147483001;
  resize: both;
  min-width: 280px;
  min-height: 320px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
}
.panel.dragging,
.panel.dragging * {
  cursor: grabbing !important;
  user-select: none !important;
}
/* the display:flex above would defeat the UA's [hidden] rule */
.panel[hidden] {
  display: none;
}
.resize-grip {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 13px;
  height: 13px;
  border-bottom-right-radius: calc(var(--ibh-radius-panel) - 3px);
  background: repeating-linear-gradient(135deg, transparent 0 3px, var(--ibh-border) 3px 4.5px);
  opacity: 0.9;
  pointer-events: none;
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ibh-border);
  background: var(--ibh-panel-2);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ibh-ok); flex: none; }
.dot.busy { background: var(--ibh-warn); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: 0.4; } }
.brand { font-weight: 700; font-size: 13px; }
.brand small { color: var(--ibh-muted); font-weight: 400; margin-left: 6px; }
.spacer { flex: 1; }
.tab {
  background: none;
  border: 1px solid transparent;
  color: var(--ibh-muted);
  border-radius: var(--ibh-radius-s);
  padding: 3px 10px;
  font-size: 12px;
}
.tab.active { color: var(--ibh-text); border-color: var(--ibh-border); background: var(--ibh-bg); }
.icon-btn {
  background: none;
  border: none;
  color: var(--ibh-muted);
  font-size: 15px;
  padding: 2px 6px;
  border-radius: var(--ibh-radius-s);
}
.icon-btn:hover { color: var(--ibh-text); background: var(--ibh-bg); }

.view { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; }
.view[hidden] { display: none; }

.msg { max-width: 92%; padding: 8px 11px; border-radius: var(--ibh-radius); white-space: pre-wrap; word-break: break-word; }
.msg.assistant { align-self: flex-start; background: var(--ibh-panel-2); border: 1px solid var(--ibh-border); }
.msg.user { align-self: flex-end; background: var(--ibh-accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.notice { align-self: center; color: var(--ibh-muted); font-size: 12px; background: none; padding: 2px; }
.status-line { align-self: flex-start; color: var(--ibh-muted); font-size: 12px; font-style: italic; }

.tool-chip {
  align-self: flex-start;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--ibh-muted);
  background: var(--ibh-bg);
  border: 1px solid var(--ibh-border);
  border-radius: var(--ibh-radius-s);
  padding: 4px 8px;
  max-width: 92%;
  overflow-wrap: anywhere;
}
.tool-chip .st { font-weight: 700; }
.tool-chip .st.allow { color: var(--ibh-ok); }
.tool-chip .st.session, .tool-chip .st.confirm { color: var(--ibh-warn); }
.tool-chip .st.deny, .tool-chip .st.error { color: var(--ibh-danger); }

.confirm-card {
  align-self: stretch;
  background: var(--ibh-panel-2);
  border: 1px solid var(--ibh-warn);
  border-radius: var(--ibh-radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.confirm-title { font-weight: 700; font-size: 13px; }
.confirm-question { font-size: 14px; font-weight: 600; line-height: 1.45; }
.confirm-summary {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: var(--ibh-bg);
  border-radius: var(--ibh-radius-s);
  padding: 8px;
  overflow-wrap: anywhere;
}
.confirm-details { margin: 0; padding-left: 16px; color: var(--ibh-muted); font-size: 12px; }
.confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
.confirm-actions button {
  border-radius: var(--ibh-radius-s);
  border: 1px solid var(--ibh-border);
  background: var(--ibh-bg);
  color: var(--ibh-text);
  padding: 5px 14px;
  font-size: 13px;
}
.confirm-actions .approve { background: var(--ibh-accent); border-color: var(--ibh-accent); color: #fff; }
.confirm-actions .approve:hover { filter: brightness(1.1); }
.confirm-actions button:disabled { opacity: 0.5; cursor: default; }
.confirm-resolved { font-size: 12px; color: var(--ibh-muted); font-style: italic; }

.audit-entry {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  border-bottom: 1px solid var(--ibh-border);
  padding: 6px 2px;
  display: flex;
  gap: 8px;
  align-items: baseline;
  overflow-wrap: anywhere;
}
.audit-time { color: var(--ibh-muted); flex: none; }
.audit-kind { color: var(--ibh-accent); flex: none; text-transform: uppercase; font-size: 10px; }
.audit-decision { flex: none; font-weight: 700; }
.audit-decision.allow { color: var(--ibh-ok); }
.audit-decision.session, .audit-decision.confirm { color: var(--ibh-warn); }
.audit-decision.deny, .audit-decision.consent-denied, .audit-decision.error { color: var(--ibh-danger); }

.empty { color: var(--ibh-muted); font-size: 13px; text-align: center; margin-top: 24px; }
.empty b { color: var(--ibh-text); }
.empty .hint { margin-top: 8px; font-size: 12px; }

.composer {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--ibh-border);
  background: var(--ibh-panel-2);
}
.composer textarea {
  flex: 1;
  resize: none;
  height: 40px;
  max-height: 120px;
  border-radius: var(--ibh-radius-s);
  border: 1px solid var(--ibh-border);
  background: var(--ibh-bg);
  color: var(--ibh-text);
  padding: 9px 11px;
  font: inherit;
  outline: none;
}
.composer textarea:focus { border-color: var(--ibh-accent); }
.composer .send {
  width: 42px;
  border: none;
  border-radius: var(--ibh-radius-s);
  background: var(--ibh-accent);
  color: #fff;
  font-size: 15px;
}
.composer .send:disabled { opacity: 0.45; cursor: default; }
.composer .send.stop { background: var(--ibh-danger); }

.composer-bar {
  display: flex;
  justify-content: flex-end;
  padding: 8px 12px 8px;
  border-top: 1px solid var(--ibh-border);
  background: var(--ibh-panel-2);
}
.composer-bar label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--ibh-muted);
  cursor: pointer;
  user-select: none;
}
.composer-bar input[type='checkbox'] {
  accent-color: var(--ibh-accent);
  margin: 0;
  width: 12px;
  height: 12px;
}
.mic {
  width: 42px;
  flex: none;
  border: none;
  border-radius: var(--ibh-radius-s);
  background: var(--ibh-accent);
  color: #fff;
  padding: 0;
  display: grid;
  place-items: center;
  transition: filter 0.15s ease;
}
.mic:hover { filter: brightness(1.1); }
.mic svg { display: block; }
.mic.recording {
  background: var(--ibh-danger);
  animation: mic-pulse 1.1s ease-in-out infinite;
}
@keyframes mic-pulse {
  50% { opacity: 0.55; }
}

/* image attachments ---------------------------------------------------------- */
.composer .attach {
  width: 42px;
  flex: none;
  border: 1px solid var(--ibh-border);
  border-radius: var(--ibh-radius-s);
  background: var(--ibh-bg);
  color: var(--ibh-muted);
  display: grid;
  place-items: center;
  padding: 0;
}
.composer .attach:hover:not(:disabled) { color: var(--ibh-text); border-color: var(--ibh-accent); }
.composer .attach:disabled { opacity: 0.45; cursor: default; }
.composer .attach svg { display: block; }

.composer-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px 0;
  background: var(--ibh-panel-2);
}
.composer-attachments[hidden] { display: none; }
.thumb {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: var(--ibh-radius-s);
  overflow: hidden;
  border: 1px solid var(--ibh-border);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-remove {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  display: grid;
  place-items: center;
}
.thumb-remove:hover { background: var(--ibh-danger); }

.msg-images { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.msg-img { max-width: 160px; max-height: 160px; border-radius: var(--ibh-radius-s); display: block; }
.msg-text:empty { display: none; }

.panel.drop-target { outline: 2px dashed var(--ibh-accent); outline-offset: -4px; }

/* markdown (assistant messages) ---------------------------------------------- */
.msg-text.md { white-space: normal; }
.msg-text.md > :first-child { margin-top: 0; }
.msg-text.md > :last-child { margin-bottom: 0; }
.msg-text.md p { margin: 0 0 0.5em; }
.msg-text.md h1, .msg-text.md h2, .msg-text.md h3, .msg-text.md h4, .msg-text.md h5, .msg-text.md h6 {
  margin: 0.6em 0 0.35em;
  line-height: 1.25;
  font-weight: 700;
}
.msg-text.md h1 { font-size: 1.25em; }
.msg-text.md h2 { font-size: 1.15em; }
.msg-text.md h3 { font-size: 1.05em; }
.msg-text.md ul, .msg-text.md ol { margin: 0.3em 0 0.5em; padding-left: 1.35em; }
.msg-text.md li { margin: 0.15em 0; }
.msg-text.md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: var(--ibh-bg);
  border: 1px solid var(--ibh-border);
  border-radius: 4px;
  padding: 0.08em 0.32em;
}
.msg-text.md pre {
  background: var(--ibh-bg);
  border: 1px solid var(--ibh-border);
  border-radius: var(--ibh-radius-s);
  padding: 8px 10px;
  overflow-x: auto;
  margin: 0.4em 0;
}
.msg-text.md pre code { background: none; border: none; padding: 0; font-size: 0.88em; }
.msg-text.md a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.msg-text.md blockquote {
  margin: 0.4em 0;
  padding-left: 0.7em;
  border-left: 3px solid var(--ibh-border);
  color: var(--ibh-muted);
}
.msg-text.md hr { border: none; border-top: 1px solid var(--ibh-border); margin: 0.6em 0; }
.msg-text.md strong { font-weight: 700; }
.msg-text.md del { opacity: 0.7; }
`;
