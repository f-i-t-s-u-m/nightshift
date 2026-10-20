import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type CredentialStore } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

type Msg = { role: string; content?: unknown; toolName?: string };

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("")
      : "";

const FIXED_PRICE = `export function totalWithTax(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  return Math.round(subtotal * (1 + taxRate) * 100) / 100;
}
`;

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));

function respond(context: { messages: Msg[]; systemPrompt?: string }) {
  const messages = context.messages;
  const system = [context.systemPrompt ?? "", ...messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values((m as { sections?: Record<string, string> }).sections ?? {})])].join("\n");
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
  const prompt = lastUser >= 0 ? textOf(messages[lastUser].content) : "";
  const step = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
  const lastTool = messages.at(-1)?.role === "toolResult" ? textOf(messages.at(-1)!.content) : "";
  const hasImage = lastUser >= 0 && Array.isArray(messages[lastUser].content) && (messages[lastUser].content as Array<{ type: string }>).some((c) => c.type === "image");

  if (prompt.includes("These problems were found") && prompt.includes("tests fails")) {
    if (step === 0) return call("write", { path: "feature.js", content: "export const value = 42;\nexport const double = (x) => x * 2;\n" });
    return say("Fixed double(): it multiplies by 2 now.");
  }
  if (prompt.includes("These problems were found") && prompt.includes("NOTES.md is missing")) {
    if (step === 0) return call("write", { path: "NOTES.md", content: "# Notes\n\ndouble() doubles numbers.\n" });
    return say("Added NOTES.md.");
  }
  if (prompt.includes("Quality task") && prompt.includes("# Task")) {
    if (step === 0) return call("write", { path: "feature.js", content: "export const value = 42;\nexport const double = (x) => x * 3;\n" });
    return say("Added double().");
  }
  if (prompt.includes("Review round 1") && prompt.includes("Quality task")) {
    if (step === 0) return call("bash", { command: "git diff --stat origin/main...HEAD" });
    return say('```json\n{"findings":[{"title":"double() silently accepts strings","detail":"double(\\"2\\") returns 4 via coercion.","severity":"major","file":"feature.js","line":2,"decision":{"question":"Should double() accept numeric strings?","options":["No, numbers only","Yes, parse strings"]}}]}\n```');
  }
  if (prompt.includes("did NOT approve deleting")) {
    // Deletes the refused file once more: Nightshift must restore it without asking again.
    if (step === 0) return call("bash", { command: "git rm -q README.md && echo removed again" });
    if (step === 1) return call("write", { path: "KEEP.md", content: "Kept everything the owner wants.\n" });
    return say("Understood: I kept the files.");
  }
  if (prompt.includes("Finish the half-done greeting") && prompt.includes("# Task")) {
    if (step === 0) return call("bash", { command: "cat half.txt" });
    if (step === 1) return call("write", { path: "half.txt", content: `hello world\n${lastTool.includes("hello") && system.includes("earlier work is on branch claude/half-done") ? "saw the earlier work" : "missed the earlier work"}\n` });
    return say("Checked the earlier work on claude/half-done and finished the greeting.");
  }
  if (prompt.includes("Read the env task") && prompt.includes("# Task")) {
    const results = messages.slice(lastUser + 1).filter((m) => m.role === "toolResult").map((m) => textOf(m.content));
    if (step === 0) return call("read", { path: ".env" });
    if (step === 1) return call("bash", { command: "cat apps/web/.env.local" });
    if (step === 2)
      return call("write", {
        path: "ENV_NOTES.md",
        content: `read: ${results[0]?.includes("owner's secrets") ? "blocked" : "allowed"}\nbash: ${results[1]?.includes("owner's secrets") ? "blocked" : "allowed"}\nprompt: ${system.includes("copied from the owner's project folder") ? "yes" : "no"}\n`,
      });
    return say("Checked the env files.");
  }
  if (system.includes("You fix the setup command Nightshift runs")) {
    return say('{"summary":"Prisma generate ran at the repository root, which has no schema.","cause":"The log says Could not find Prisma Schema.","command":"echo setup-fixed"}');
  }
  if (system.includes("You diagnose why a local dev server")) {
    if (prompt.includes("Cannot find module"))
      return say('```json\n{"summary":"A dependency is missing, so the app crashes on start.","cause":"The log shows Error: Cannot find module left-pad.","fix":{"install":"npm install"},"agentPrompt":"Add left-pad to the app dependencies or remove the import, then run the checks."}\n```');
    return say('{"summary":"The app ignores PORT and listens on 3999.","cause":"The log says Listening on http://localhost:3999.","fix":{"command":"node server.cjs --use-port"},"agentPrompt":null}');
  }
  if (system.includes("You set up local previews for Nightshift")) {
    return say('{"preview":{"services":[{"name":"web","cwd":"apps/web","command":"npm run dev -- --port $PORT","primary":true,"env":{"API_URL":"{{api.url}}"}},{"name":"api","cwd":"apps/api","command":"npm run start"}]},"notes":["The web app calls the api through API_URL."]}');
  }
  const history = messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
  if (prompt.includes("Fix the login bug") && prompt.includes("# Task")) {
    if (step === 0) {
      const first = system.match(/read these first:\n- (\S+) \(/)?.[1] ?? "none";
      return call("write", { path: "TYPE_NOTES.md", content: `${system.includes("This task is a bug fix") ? "typed bug" : "untyped"}\nfirst skill: ${first}\n` });
    }
    return say("Fixed the login bug.");
  }
  if (history.includes("Budget task")) {
    if (prompt.includes("reached its budget")) {
      if (step === 0) return call("write", { path: "continued.txt", content: "continued after the budget pause\n" });
      return say("Continued after the budget pause.");
    }
    if (prompt.includes("Nightshift is retrying")) {
      if (step === 0) return call("write", { path: "retried.txt", content: "retried\n" });
      return say("Finished on retry.");
    }
    if (prompt.includes("Keep going")) {
      if (step === 0) return call("write", { path: "after-message.txt", content: "kept going\n" });
      return say("Kept going after your message.");
    }
    if (prompt.includes("# Task")) {
      if (step === 0) return call("write", { path: "a.txt", content: "a\n" });
      if (step === 1) return call("bash", { command: "sleep 3 && echo waited" });
      if (step === 2) return call("write", { path: "b.txt", content: "b\n" });
      return say("Finished the budget task.");
    }
  }
  if (prompt.includes("Style the landing page") && prompt.includes("# Task")) {
    const listed = [...system.matchAll(/^- (.+?) \((\.[^)]+SKILL\.md)\):/gm)].map((m) => ({ name: m[1], path: m[2] }));
    const design = listed.find((s) => s.name === "frontend-design");
    if (step === 0 && design) return call("read", { path: design.path });
    const followed = lastTool.includes("# Frontend design") ? "read frontend-design" : "no design skill";
    if (step <= 1) return call("write", { path: "DESIGN_NOTES.md", content: `${followed}\nskills: ${listed.map((s) => s.name).sort().join(", ")}\n` });
    return say("Styled the landing page following the frontend-design skill.");
  }
  if (prompt.includes("Delete the readme") && prompt.includes("# Task")) {
    if (step === 0) return call("bash", { command: "git rm -q README.md && echo removed" });
    return say("Removed README.md.");
  }
  if (prompt.includes("Add a dev server") && prompt.includes("# Task")) {
    if (step === 0) return call("write", { path: "package.json", content: JSON.stringify({ name: "demo", type: "module", scripts: { dev: "vite", test: "vitest", typecheck: "tsc --noEmit" }, devDependencies: { vite: "8.0.0", vitest: "4.0.0" } }, null, 2) });
    return say("Added a Vite dev server.");
  }
  if (prompt.includes("Transcript of the previous session")) {
    return say("## Goal\nFinish the task.\n\n## Done so far\nWrote the first files.\n\n## Next steps\nAddress the latest feedback.");
  }
  if (prompt.includes("You are starting a fresh session")) {
    if (step === 0) return call("write", { path: "fresh.txt", content: "continued in a fresh session\n" });
    return say("Continued the task in a fresh session.");
  }
  if (prompt.includes("Slow task") && !prompt.includes("Where the previous session left off")) {
    if (step === 0) return call("bash", { command: "sleep 4 && echo slow" });
    if (step === 1) return call("write", { path: "slow2.txt", content: "done\n" });
    return say("Finished the slow task.");
  }
  if (prompt.includes("Write the project brief")) {
    return say(`## What it is\nA shop built with ${prompt.includes("Next.js") ? "Next.js" : "unknown stack"}.\n\n## How to run and test\npnpm test`);
  }
  if (prompt.includes("PLANNING STEP")) {
    if (step === 0) return call("read", { path: "server.cjs" });
    if (step === 1) return call("submit_plan", { plan: "1. Add a users count line to the README.\n2. Verify with the preview at /.\n3. Run the checks." });
    return say("Plan submitted.");
  }
  if (prompt.includes("Review round")) {
    if (step === 0) return call("bash", { command: "git diff --stat origin/main...HEAD" });
    if (prompt.includes("Review round 1") && prompt.includes("users")) return say("1. README.md: the users line should say how the count is computed.");
    return say("NO FURTHER FINDINGS");
  }
  if (prompt.includes("A code reviewer found these problems") || (prompt.includes("These problems were found") && prompt.includes("count is computed"))) {
    if (step === 0) return call("write", { path: "COUNT.md", content: "The users count comes from SELECT count(*) FROM users.\n" });
    return say("Explained how the count is computed.");
  }
  if (prompt.includes("Use tabs")) {
    if (step === 0) return call("write", { path: "STYLE.md", content: "Indent with tabs.\n" });
    return say("Switched to tabs as you asked.");
  }
  if (prompt.includes("Also add a header")) {
    if (step === 0) return call("write", { path: "header.txt", content: "Header\n" });
    return say("Added header.txt.");
  }
  if (prompt.includes("Task T-1:")) {
    if (step === 0) return call("write", { path: "footer.txt", content: hasImage ? "Footer (matches the screenshot)\n" : "Footer (no screenshot received)\n" });
    return say(hasImage ? "Added footer.txt based on your screenshot." : "Added footer.txt.");
  }
  if (prompt.includes("Task T-2:")) {
    if (step === 0) return call("bash", { command: "sleep 3 && echo slow work done" });
    if (step === 1) return call("write", { path: "slow.txt", content: "done\n" });
    return say("Finished the slow task.");
  }

  if (prompt.includes("New feedback arrived")) {
    if (step === 0) return call("write", { path: "CHANGELOG.md", content: "# Changelog\n\n- Tax is applied as a percentage.\n" });
    if (step === 1) return call("run_checks", {});
    return say("Addressed the CI failure: added the missing changelog entry the release check asks for.");
  }
  if (prompt.includes("answered your question")) {
    if (step === 0) return call("write", { path: "README.md", content: "# Demo\n\n## Running tests\n\nRun `node --test` from the repository root.\n" });
    if (step === 1) return call("run_checks", {});
    return say("Added a 'Running tests' section to README.md as the owner asked.");
  }
  if (prompt.includes("You were paused")) return say("Resumed and confirmed the work is complete.");
  if (prompt.includes("Task WC-1:")) {
    if (step === 0) return call("read", { path: "price.js" });
    if (step === 1) return call("write", { path: "price.js", content: FIXED_PRICE });
    if (step === 2) return call("run_checks", {});
    return say("Fixed totalWithTax: the tax rate is now applied as a percentage of the subtotal instead of being added to it. `node --test` passes.");
  }
  if (prompt.includes("Task WC-2:")) {
    if (step === 0) return call("ask_question", { question: "Should the README section also mention coverage reports?" });
    return say("Waiting for an answer.");
  }
  if (prompt.includes("Task WC-4:")) {
    if (step === 0) return call("bash", { command: "sleep 8 && echo late > orphan-marker.txt" });
    if (step === 1) {
      if (lastTool.includes("interrupted")) return call("write", { path: "NOTES.md", content: "Recovered after an interruption.\n" });
      return call("write", { path: "NOTES.md", content: "Finished without interruption.\n" });
    }
    if (step === 2) return call("run_checks", {});
    return say("Wrote NOTES.md.");
  }
  const generic = prompt.match(/^# Task (\S+): (.*)$/m);
  if (generic) {
    if (step === 0) return call("write", { path: `nightshift-notes/${generic[1]}.md`, content: `# ${generic[2]}\n\nDemo change for this task${hasImage ? " (the agent received your picture)" : ""}.\n` });
    return say(`Demo agent: wrote nightshift-notes/${generic[1]}.md for "${generic[2]}".${hasImage ? " I received your picture." : ""}`);
  }
  if (prompt && !prompt.startsWith("You were paused")) {
    if (step === 0) return call("write", { path: `nightshift-notes/message-${Date.now()}.md`, content: `${prompt.slice(0, 500)}\n` });
    return say(`Demo agent: noted your message${hasImage ? " and picture" : ""}: "${prompt.slice(0, 120)}"`);
  }
  return say("Done.");
}

export function createTestModels(credentials?: CredentialStore) {
  const faux = fauxProvider({
    models: [
      { id: "scripted", input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
      { id: "scripted-reviewer", input: ["text"], cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 } },
    ],
  });
  faux.setResponses(Array.from({ length: 20000 }, () => respond as never));
  const models = createModels(credentials ? { credentials } : undefined);
  models.setProvider(faux.provider);
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  const model = faux.getModel();
  return { models, model: { provider: model.provider, modelId: model.id }, providers: ["anthropic", "openai", "openrouter", model.provider] };
}
