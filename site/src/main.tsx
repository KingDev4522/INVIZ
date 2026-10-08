import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import "@/index.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root element #root is missing from index.html");
}

try {
  const theme = new URLSearchParams(window.location.search).get("theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  }
  if (new URLSearchParams(window.location.search).has("static")) {
    document.documentElement.classList.add("static");
  }
} catch {
  // URL parsing is optional; defaults apply.
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
