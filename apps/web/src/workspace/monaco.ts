import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setCompilerOptions({ jsx: monaco.typescript.JsxEmit.Preserve, allowJs: true, allowNonTsExtensions: true, target: monaco.typescript.ScriptTarget.ESNext });
}

loader.config({ monaco });

const EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  sql: "sql",
  prisma: "graphql",
  graphql: "graphql",
  gql: "graphql",
  xml: "xml",
  svg: "xml",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  dockerfile: "dockerfile",
};

const BASENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  ".env": "ini",
  ".gitignore": "ini",
};

export const languageFor = (path: string, hint?: string | null): string => {
  const known = monaco.languages.getLanguages().map((l) => l.id);
  if (hint && known.includes(hint)) return hint;
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (BASENAMES[base]) return BASENAMES[base];
  if (base.startsWith(".env")) return "ini";
  const ext = base.includes(".") ? base.split(".").pop() ?? "" : "";
  return EXTENSIONS[ext] ?? "plaintext";
};

export { monaco };
