import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export type Route =
  | { name: "home" }
  | { name: "agents" }
  | { name: "usage" }
  | { name: "models" }
  | { name: "skills" }
  | { name: "newProject" }
  | { name: "project"; projectId: string }
  | { name: "projectSettings"; projectId: string }
  | { name: "task"; projectId: string; taskId: string }
  | { name: "run"; id: string }
  | { name: "missing"; path: string };

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseRoute = (hash: string): Route => {
  const path = (hash.replace(/^#/, "") || "/").replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/agents") return { name: "agents" };
  if (path === "/usage") return { name: "usage" };
  if (path === "/settings/models") return { name: "models" };
  if (path === "/skills" || path === "/settings/skills") return { name: "skills" };
  if (path === "/projects/new") return { name: "newProject" };
  const task = /^\/projects\/([^/]+)\/tasks\/([^/]+)$/.exec(path);
  if (task?.[1] && task[2]) return { name: "task", projectId: decode(task[1]), taskId: decode(task[2]) };
  const settings = /^\/projects\/([^/]+)\/settings$/.exec(path);
  if (settings?.[1]) return { name: "projectSettings", projectId: decode(settings[1]) };
  const project = /^\/projects\/([^/]+)$/.exec(path);
  if (project?.[1]) return { name: "project", projectId: decode(project[1]) };
  const run = /^\/runs\/([^/]+)$/.exec(path);
  if (run?.[1]) return { name: "run", id: decode(run[1]) };
  return { name: "missing", path };
};

const enc = encodeURIComponent;

export const projectHref = (projectId: string) => `#/projects/${enc(projectId)}`;
export const projectSettingsHref = (projectId: string) => `#/projects/${enc(projectId)}/settings`;
export const taskHref = (projectId: string, taskId: string) => `#/projects/${enc(projectId)}/tasks/${enc(taskId)}`;
export const modelsHref = "#/settings/models";
export const skillsHref = "#/skills";
export const runHref = (id: string) => `#/runs/${enc(id)}`;

export const navigate = (href: string, replace = false) => {
  if (replace) {
    window.history.replaceState(null, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = href;
  }
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
