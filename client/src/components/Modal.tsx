/**
 * In-app modal primitives. Replaces window.prompt / window.confirm / window.
 * alert so UI-triggered dialogs look like the rest of the app instead of the
 * browser's default popup.
 *
 * Usage:
 *   const modal = useModal();
 *   const name = await modal.prompt({ title: "Rename", label: "New name", defaultValue: "foo" });
 *   if (name) ...
 *   const ok = await modal.confirm({ title: "Delete?", destructive: true });
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { IconClose, IconCheck } from "../design/icons";

interface PromptOpts {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}
interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type PromptState = PromptOpts & { kind: "prompt"; resolve: (v: string | null) => void };
type ConfirmState = ConfirmOpts & { kind: "confirm"; resolve: (v: boolean) => void };
type State = PromptState | ConfirmState | null;

interface ModalApi {
  prompt: (opts: PromptOpts) => Promise<string | null>;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
}

const ModalContext = createContext<ModalApi | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);

  const api: ModalApi = {
    prompt: (opts) => new Promise((resolve) => setState({ kind: "prompt", ...opts, resolve })),
    confirm: (opts) => new Promise((resolve) => setState({ kind: "confirm", ...opts, resolve })),
  };

  return (
    <ModalContext.Provider value={api}>
      {children}
      {state && <ModalRoot state={state} close={() => setState(null)} />}
    </ModalContext.Provider>
  );
}

export function useModal(): ModalApi {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("useModal must be used inside <ModalProvider>");
  return ctx;
}

function ModalRoot({ state, close }: { state: NonNullable<State>; close: () => void }) {
  const [value, setValue] = useState(state.kind === "prompt" ? (state.defaultValue ?? "") : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.kind === "prompt") {
      setValue(state.defaultValue ?? "");
      setTimeout(() => inputRef.current?.focus(), 20);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (state.kind === "prompt") state.resolve(null);
        else state.resolve(false);
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const cancel = () => {
    if (state.kind === "prompt") state.resolve(null);
    else state.resolve(false);
    close();
  };
  const submit = () => {
    if (state.kind === "prompt") state.resolve(value.trim() || null);
    else state.resolve(true);
    close();
  };

  return (
    <>
      <div className="drawer-bg" onClick={cancel} />
      <div className="app-modal" role="dialog" aria-modal="true">
        <div className="app-modal-head">
          <div className="app-modal-title">{state.title}</div>
          <button className="icon-btn" onClick={cancel} aria-label="Close"><IconClose size={15} /></button>
        </div>
        <div className="app-modal-body">
          {state.kind === "prompt" ? (
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {state.label && (
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-mute)" }}>
                  {state.label}
                </span>
              )}
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                placeholder={state.placeholder}
                style={{
                  padding: "9px 12px", fontSize: 13, borderRadius: 8,
                  background: "var(--panel)", border: "1.5px solid var(--hairline)",
                  color: "var(--text)",
                }}
              />
            </label>
          ) : (
            state.message && <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>{state.message}</div>
          )}
        </div>
        <div className="app-modal-foot">
          <button className="pill-btn" onClick={cancel}>
            {state.kind === "prompt" ? (state.cancelLabel ?? "Cancel") : (state.cancelLabel ?? "Cancel")}
          </button>
          <button
            className={`pill-btn primary${state.kind === "confirm" && state.destructive ? " danger" : ""}`}
            onClick={submit}
            disabled={state.kind === "prompt" && !value.trim()}
          >
            <IconCheck size={12} />
            {state.kind === "prompt" ? (state.confirmLabel ?? "OK") : (state.confirmLabel ?? "Confirm")}
          </button>
        </div>
      </div>
    </>
  );
}
