import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Suspense } from "react";
import "./i18n";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense>
      <App />
    </Suspense>
  </StrictMode>,
);
