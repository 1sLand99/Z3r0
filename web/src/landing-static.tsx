import React from "react";
import ReactDOM, { hydrateRoot } from "react-dom/client";
import "./app/styles/landing-static.css";
import { LandingContent } from "./features/landing/LandingContent";
import { landingPrimaryAction } from "./features/landing/landingConfig";
import { useAutoHideScrollbars } from "./shared/hooks/useAutoHideScrollbars";
import z3r0Logo from "./assets/z3r0-logo.png";

const rootElement = document.getElementById("root") as HTMLElement;
const landing = (
  <React.StrictMode>
    <LandingApplication />
  </React.StrictMode>
);

function LandingApplication() {
  useAutoHideScrollbars();

  return (
    <LandingContent logoSrc={z3r0Logo} primaryAction={landingPrimaryAction} />
  );
}

if (rootElement.hasChildNodes()) {
  hydrateRoot(rootElement, landing);
} else {
  ReactDOM.createRoot(rootElement).render(landing);
}
