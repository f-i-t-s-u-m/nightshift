import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { run } from "@nightshift/git";

export const LABEL = "dev.nightshift.daemon";

export const plistPath = () => path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(options: { node: string; cli: string; configFile: string; logDir: string }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(options.node)}</string>
    <string>${escape(options.cli)}</string>
    <string>serve</string>
    <string>--config</string>
    <string>${escape(options.configFile)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(path.join(options.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escape(path.join(options.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

export async function installService(options: { cli: string; configFile: string; logDir: string }) {
  if (process.platform !== "darwin") throw new Error("The background service uses launchd and works on macOS only. Use `nightshift serve` elsewhere.");
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  mkdirSync(options.logDir, { recursive: true });
  writeFileSync(plistPath(), plist({ node: process.execPath, ...options }));
  const domain = `gui/${userInfo().uid}`;
  await run("launchctl", ["bootout", `${domain}/${LABEL}`]);
  const res = await run("launchctl", ["bootstrap", domain, plistPath()]);
  if (res.code !== 0) throw new Error(`launchctl bootstrap failed: ${res.stderr.trim()}`);
  return plistPath();
}

export async function uninstallService() {
  const domain = `gui/${userInfo().uid}`;
  await run("launchctl", ["bootout", `${domain}/${LABEL}`]);
  if (existsSync(plistPath())) rmSync(plistPath());
}
