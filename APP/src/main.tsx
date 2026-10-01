import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import OperationalPOS from "./OperationalPOS";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OperationalPOS />
  </StrictMode>,
);

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}
