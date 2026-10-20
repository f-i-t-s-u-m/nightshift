import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import "./index.css";
import { App } from "./App";
import { LiveProvider } from "./live";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="nightshift.theme">
        <TooltipProvider delayDuration={300}>
          <LiveProvider>
            <App />
          </LiveProvider>
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
