import React from "react";
import { ArrowDown, Check, CircleNotch, CloudCheck, X } from "@phosphor-icons/react";
import "./update-dialog.css";

export function UpdateDialog({ update, appVersion, status, progress, error, busy, onCheck, onInstall, onClose }) {
  const installing = status === "downloading" || status === "installing";
  const checking = status === "checking";
  const noUpdate = status === "current";
  const installed = status === "installed";
  const message = update?.body?.trim() || "A new OPAL build is ready with refinements and fixes.";

  return (
    <div className="modal-backdrop update-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !installing) onClose(); }}>
      <section className="update-dialog glass" role="dialog" aria-modal="true" aria-labelledby="update-title">
        {!installing && <button className="modal-close" type="button" onClick={onClose} aria-label="Close update window"><X size={18} /></button>}
        <div className="update-dialog-mark" aria-hidden="true">{installed ? <Check size={22} weight="light" /> : <CloudCheck size={22} weight="light" />}</div>
        <span className="eyebrow">OPAL · SOFTWARE UPDATE</span>
        <h2 id="update-title">{installed ? "Update ready." : update ? "A new version." : "Stay in tune."}</h2>
        {update ? <>
          <div className="update-version-line"><span>Version {update.version}</span><span>Currently on {appVersion}</span></div>
          <p className="update-release-notes">{message}</p>
        </> : <p className="update-release-notes">{noUpdate ? "You’re already on the latest OPAL alpha." : checking ? "Checking the alpha channel…" : "Check the OPAL alpha channel for the latest release."}</p>}
        {busy && update && !installing && <p className="update-prerequisite" role="status">Finish the active import, backup, or restore first. The update will stay ready.</p>}
        {error && <p className="update-error" role="alert">{error}</p>}
        {installing && <div className="update-progress" role="status"><CircleNotch className="spin" size={17} /><span>{status === "installing" ? "Preparing your update…" : progress.total > 0 ? `Downloading the signed update · ${Math.min(100, Math.round((progress.received / progress.total) * 100))}%` : "Downloading the signed update…"}</span></div>}
        <div className="update-dialog-actions">
          {update ? <button className="button button-primary" type="button" onClick={onInstall} disabled={installing || busy || installed}><ArrowDown size={16} />{installed ? "Installed" : busy ? "Finish library activity first" : status === "error" ? "Try again" : "Install update"}</button> : <button className="button button-primary" type="button" onClick={onCheck} disabled={checking}><CloudCheck size={16} />{checking ? "Checking…" : status === "error" ? "Try checking again" : "Check for updates"}</button>}
          {!installing && !installed && <button className="button button-ghost" type="button" onClick={onClose}>Later</button>}
          {installed && <button className="button button-ghost" type="button" onClick={onClose}>Done</button>}
        </div>
        <p className="update-footnote">Installing restarts OPAL. Your library, versions, notes, and artwork stay on this device.</p>
      </section>
    </div>
  );
}
