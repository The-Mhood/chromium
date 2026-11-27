import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { LinkDialog } from "./components/LinkDialog";

// The main process loads this same renderer in a small frameless window for
// the double-click link options (?linkDialog=1). That window renders ONLY the
// dialog — never the full browser shell.
const isLinkDialog = new URLSearchParams(window.location.search).has("linkDialog");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isLinkDialog ? <LinkDialog /> : <App />}
  </StrictMode>
);
