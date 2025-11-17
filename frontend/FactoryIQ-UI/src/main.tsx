// client/src/main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./components/Auth/AuthContext";
// main.tsx (или index.tsx) — ДО любых импортов http/useApi
if (!(window as any).__ORIGINAL_FETCH__) {
  (window as any).__ORIGINAL_FETCH__ = window.fetch.bind(window);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
