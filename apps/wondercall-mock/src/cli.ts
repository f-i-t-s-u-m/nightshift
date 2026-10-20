#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { startMockWonderCall, type MockOptions } from "./index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const tasksFile = flag("tasks");
const tasks: MockOptions["tasks"] = tasksFile
  ? JSON.parse(readFileSync(tasksFile, "utf8"))
  : [
      {
        id: "WC-101",
        title: "Fix tax calculation in totals",
        body: "Totals with tax are wrong: `totalWithTax` adds the rate instead of applying it as a percentage. `node --test` fails.",
      },
      {
        id: "WC-102",
        title: "Add a README section about running tests",
        body: "Add a short 'Running tests' section to README.md that says to run `node --test`.",
      },
    ];

const mock = await startMockWonderCall({ port: Number(flag("port") ?? 8790), token: flag("token"), tasks });
console.log(`WonderCall mock MCP server at ${mock.url}`);
console.log(`State: ${mock.url.replace("/mcp", "/admin/state")}`);
