import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
