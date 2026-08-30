"use strict";

const { localDateParts, markdownEscape, safeFileName, shortHash, yamlString } = require("./util");

const CODE_PLATFORM_MODES = ["extract", "bookmark", "both"];

// Platform recognition stays data-driven. A platform can provide a small path
// parser when its repository URL does not use the common /owner/repository form.
const CODE_PLATFORM_SERVICES = {
  github: { name: "GitHub", region: "international", hosts: ["github.com"], kind: "owner-repo" },
  gitlab: { name: "GitLab", region: "international", hosts: ["gitlab.com"], kind: "gitlab" },
  bitbucket: { name: "Bitbucket", region: "international", hosts: ["bitbucket.org"], kind: "owner-repo" },
  azure: { name: "Azure DevOps", region: "international", hosts: ["dev.azure.com", "visualstudio.com"], kind: "azure" },
  codeberg: { name: "Codeberg", region: "international", hosts: ["codeberg.org"], kind: "owner-repo" },
  sourcehut: { name: "SourceHut", region: "international", hosts: ["git.sr.ht", "sr.ht"], kind: "sourcehut" },
  sourceforge: { name: "SourceForge", region: "international", hosts: ["sourceforge.net", "git.code.sf.net"], kind: "sourceforge" },
  launchpad: { name: "Launchpad", region: "international", hosts: ["launchpad.net", "code.launchpad.net"], kind: "launchpad" },
  savannah: { name: "GNU Savannah", region: "international", hosts: ["savannah.gnu.org", "savannah.nongnu.org"], kind: "savannah" },
  huggingface: { name: "Hugging Face Hub", region: "international", hosts: ["huggingface.co"], kind: "huggingface" },
  gitflic: { name: "GitFlic", region: "international", hosts: ["gitflic.ru"], kind: "gitflic" },
  googlesource: { name: "Google Git", region: "international", hosts: ["googlesource.com"], kind: "googlesource" },
  gitee: { name: "Gitee", region: "china", hosts: ["gitee.com"], kind: "owner-repo" },
  gitcode: { name: "GitCode", region: "china", hosts: ["gitcode.com"], kind: "gitlab" },
  jihulab: { name: "JiHu GitLab", region: "china", hosts: ["jihulab.com"], kind: "gitlab" },
  coding: { name: "CODING", region: "china", hosts: ["coding.net"], kind: "coding" },
  atomgit: { name: "AtomGit", region: "china", hosts: ["atomgit.com"], kind: "owner-repo" },
  gitlink: { name: "GitLink", region: "china", hosts: ["gitlink.org.cn"], kind: "owner-repo" },
};

const RESERVED_ROOTS = new Set([
  "about", "account", "apps", "blog", "dashboard", "explore", "features", "help", "issues", "login", "marketplace",
  "new", "notifications", "orgs", "pricing", "projects", "search", "security", "settings", "signup", "support", "topics", "users",
]);

const RESOURCE_MARKERS = {
  issues: "issue", issue: "issue", pulls: "pull-request", pull: "pull-request", "pull-requests": "pull-request",
  merge_requests: "merge-request", discussions: "discussion", releases: "release", release: "release",
  commit: "commit", commits: "commit", blob: "file", raw: "file", src: "file", files: "file",
  tree: "tree", wiki: "wiki", tags: "tag", actions: "automation", pipelines: "automation", packages: "package",
  downloads: "download", tickets: "issue",
};

function hostMatches(hostname, suffix) {
  const host = String(hostname || "").toLowerCase().replace(/^www\.|\.$/g, "");
  const target = String(suffix || "").toLowerCase().replace(/^www\./, "");
  return host === target || host.endsWith(`.${target}`);
}

function pathSegments(url) {
  return url.pathname.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch (_) { return segment; }
  });
}

function cleanRepositoryPart(value) {
  return String(value || "").replace(/\.git$/i, "").trim();
}

function resourceFromTail(tail, url) {
  const clean = tail.filter((segment) => segment && segment !== "-");
  const index = clean.findIndex((segment) => RESOURCE_MARKERS[String(segment).toLowerCase()]);
  if (index >= 0) {
    const marker = String(clean[index]).toLowerCase();
    return { resourceType: RESOURCE_MARKERS[marker], resourceId: clean[index + 1] || "" };
  }
  if (url.searchParams.has("path")) return { resourceType: "file", resourceId: url.searchParams.get("path") || "" };
  if (clean.length) return { resourceType: "repository-page", resourceId: clean.at(-1) };
  return { resourceType: "repository", resourceId: "" };
}

function ownerRepoInfo(segments, url) {
  if (segments.length < 2 || RESERVED_ROOTS.has(String(segments[0]).toLowerCase())) return null;
  const owner = segments[0];
  const repositoryName = cleanRepositoryPart(segments[1]);
  if (!owner || !repositoryName) return null;
  return { repository: `${owner}/${repositoryName}`, ...resourceFromTail(segments.slice(2), url) };
}

function gitlabInfo(segments, url) {
  const dash = segments.indexOf("-");
  const markers = new Set(["issues", "merge_requests", "releases", "commit", "commits", "blob", "tree", "tags", "pipelines", "packages", "wikis"]);
  let boundary = dash;
  if (boundary < 0) boundary = segments.findIndex((segment, index) => index >= 2 && markers.has(String(segment).toLowerCase()));
  if (boundary < 0) boundary = segments.length;
  const repositoryParts = segments.slice(0, boundary);
  if (repositoryParts.length < 2 || RESERVED_ROOTS.has(String(repositoryParts[0]).toLowerCase())) return null;
  repositoryParts[repositoryParts.length - 1] = cleanRepositoryPart(repositoryParts.at(-1));
  if (!repositoryParts.at(-1)) return null;
  return { repository: repositoryParts.join("/"), ...resourceFromTail(segments.slice(boundary), url) };
}

function azureInfo(segments, url, hostname) {
  const gitIndex = segments.indexOf("_git");
  if (gitIndex < 0 || !segments[gitIndex + 1]) return null;
  const prefix = String(hostname).toLowerCase().endsWith(".visualstudio.com")
    ? [String(hostname).split(".")[0], ...segments.slice(0, gitIndex)]
    : segments.slice(0, gitIndex);
  return { repository: [...prefix, cleanRepositoryPart(segments[gitIndex + 1])].filter(Boolean).join("/"), ...resourceFromTail(segments.slice(gitIndex + 2), url) };
}

function sourcehutInfo(segments, url) {
  const offset = segments[0] === "git" ? 1 : 0;
  const owner = segments[offset];
  const repo = cleanRepositoryPart(segments[offset + 1]);
  if (!owner?.startsWith("~") || !repo) return null;
  return { repository: `${owner}/${repo}`, ...resourceFromTail(segments.slice(offset + 2), url) };
}

function sourceforgeInfo(segments, url, hostname) {
  if (hostname === "git.code.sf.net") {
    const projectIndex = segments.indexOf("p");
    if (projectIndex < 0 || !segments[projectIndex + 1]) return null;
    const project = segments[projectIndex + 1];
    const repo = cleanRepositoryPart(segments[projectIndex + 2] || project);
    return { repository: `${project}/${repo}`, ...resourceFromTail(segments.slice(projectIndex + 3), url) };
  }
  const projectIndex = ["projects", "p"].includes(segments[0]) ? 0 : -1;
  if (projectIndex < 0 || !segments[1]) return null;
  const project = cleanRepositoryPart(segments[1]);
  return { repository: project, ...resourceFromTail(segments.slice(2), url) };
}

function launchpadInfo(segments, url, hostname) {
  if (!segments.length || RESERVED_ROOTS.has(String(segments[0]).toLowerCase())) return null;
  if (hostname === "code.launchpad.net" && segments[0]?.startsWith("~") && segments.length >= 3) {
    return { repository: `${segments[0]}/${segments[1]}/${cleanRepositoryPart(segments[2])}`, ...resourceFromTail(segments.slice(3), url) };
  }
  return { repository: cleanRepositoryPart(segments[0]), ...resourceFromTail(segments.slice(1), url) };
}

function savannahInfo(segments, url) {
  const group = url.searchParams.get("group") || (segments[0] === "projects" ? segments[1] : "");
  if (!group) return null;
  return { repository: cleanRepositoryPart(group), ...resourceFromTail(segments.slice(2), url) };
}

function huggingfaceInfo(segments, url) {
  const typePrefix = ["datasets", "spaces", "models"].includes(segments[0]) ? segments.shift() : "models";
  if (segments.length < 2 || RESERVED_ROOTS.has(String(segments[0]).toLowerCase())) return null;
  const info = ownerRepoInfo(segments, url);
  return info ? { ...info, repository: `${typePrefix}/${info.repository}` } : null;
}

function gitflicInfo(segments, url) {
  if (segments[0] !== "project" || segments.length < 3) return null;
  return { repository: `${segments[1]}/${cleanRepositoryPart(segments[2])}`, ...resourceFromTail(segments.slice(3), url) };
}

function googlesourceInfo(segments, url, hostname) {
  if (!String(hostname).toLowerCase().endsWith(".googlesource.com") || !segments[0]) return null;
  return { repository: `${String(hostname).split(".")[0]}/${cleanRepositoryPart(segments[0])}`, ...resourceFromTail(segments.slice(1), url) };
}

function codingInfo(segments, url) {
  const userIndex = segments.indexOf("u");
  const projectIndex = segments.indexOf("p");
  const repoIndex = segments.indexOf("d");
  if (userIndex < 0 || projectIndex < 0 || repoIndex < 0 || !segments[userIndex + 1] || !segments[projectIndex + 1] || !segments[repoIndex + 1]) return null;
  const tailStart = segments[repoIndex + 2] === "git" ? repoIndex + 3 : repoIndex + 2;
  return {
    repository: `${segments[userIndex + 1]}/${segments[projectIndex + 1]}/${cleanRepositoryPart(segments[repoIndex + 1])}`,
    ...resourceFromTail(segments.slice(tailStart), url),
  };
}

const PARSERS = {
  "owner-repo": (segments, url) => ownerRepoInfo(segments, url),
  gitlab: (segments, url) => gitlabInfo(segments, url),
  azure: (segments, url, hostname) => azureInfo(segments, url, hostname),
  sourcehut: (segments, url) => sourcehutInfo(segments, url),
  sourceforge: (segments, url, hostname) => sourceforgeInfo(segments, url, hostname),
  launchpad: (segments, url, hostname) => launchpadInfo(segments, url, hostname),
  savannah: (segments, url) => savannahInfo(segments, url),
  huggingface: (segments, url) => huggingfaceInfo([...segments], url),
  gitflic: (segments, url) => gitflicInfo(segments, url),
  googlesource: (segments, url, hostname) => googlesourceInfo(segments, url, hostname),
  coding: (segments, url) => codingInfo(segments, url),
};

function normalizeAdditionalHosts(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,，;；]+/);
  return [...new Set(values.map((host) => String(host).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")).filter(Boolean))].slice(0, 50);
}

function normalizeCodePlatformMode(value) {
  return CODE_PLATFORM_MODES.includes(value) ? value : "extract";
}

function normalizeCodeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|spm|from|source)$/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function classifyCodePlatformUrl(value, additionalHosts = "") {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = pathSegments(url);
  for (const [id, service] of Object.entries(CODE_PLATFORM_SERVICES)) {
    if (!service.hosts.some((host) => hostMatches(hostname, host))) continue;
    const info = PARSERS[service.kind](segments, url, hostname);
    if (!info) return null;
    return { id, name: service.name, region: service.region, hostname, url: normalizeCodeUrl(url), ...info };
  }
  const customHost = normalizeAdditionalHosts(additionalHosts).find((host) => hostMatches(hostname, host));
  if (!customHost) return null;
  const info = gitlabInfo(segments, url) || ownerRepoInfo(segments, url);
  if (!info) return null;
  return { id: `custom-${shortHash(customHost)}`, name: customHost, region: "custom", hostname, url: normalizeCodeUrl(url), ...info };
}

function codePlatformCoverage(region) {
  return Object.entries(CODE_PLATFORM_SERVICES)
    .filter(([, service]) => !region || service.region === region)
    .map(([id, service]) => ({ id, name: service.name }));
}

function resourceLabel(info) {
  const names = {
    issue: "Issue", "pull-request": "Pull Request", "merge-request": "Merge Request", discussion: "Discussion",
    release: "Release", commit: "Commit", file: "File", tree: "Tree", wiki: "Wiki", tag: "Tag",
    automation: "Automation", package: "Package", download: "Download", "repository-page": "Page", repository: "Repository",
  };
  const label = names[info.resourceType] || "Page";
  return info.resourceId ? `${label} ${info.resourceId}` : label;
}

class CodePlatformBookmarkStore {
  constructor(writer, settings) {
    this.writer = writer;
    this.settings = settings;
  }

  async save(value, context = {}, classified = null) {
    const info = classified || classifyCodePlatformUrl(value, this.settings.capture.codePlatformAdditionalHosts);
    if (!info) throw new Error("Unsupported code-platform URL");
    const date = localDateParts(context.timestamp || new Date());
    const title = `${info.name} · ${info.repository} · ${resourceLabel(info)}`;
    const platformFolder = safeFileName(info.name, info.id);
    const stem = safeFileName(`${info.repository}-${resourceLabel(info)}`, info.id);
    const notePath = `${this.settings.storage.codePlatformFolder}/${platformFolder}/${stem}-${shortHash(info.url)}.md`;
    const content = [
      "---",
      "type: code-platform-link",
      `platform: ${yamlString(info.name)}`,
      `platform_id: ${yamlString(info.id)}`,
      `repository: ${yamlString(info.repository)}`,
      `resource_type: ${yamlString(info.resourceType)}`,
      `resource_id: ${yamlString(info.resourceId || "")}`,
      `source: ${yamlString(info.url)}`,
      `saved_at: ${yamlString(date.iso)}`,
      `channel: ${yamlString(context.channel || "manual")}`,
      "tags:",
      "  - omnichannel-diary",
      "  - code-platform-link",
      `  - code-platform-${safeFileName(info.id, "custom").toLowerCase()}`,
      "---",
      "",
      `# ${markdownEscape(title)}`,
      "",
      `[Open original link](<${info.url}>)`,
      "",
      `- Platform: ${info.name}`,
      `- Repository: ${info.repository}`,
      `- Resource: ${resourceLabel(info)}`,
      "",
    ].join("\n");
    await this.writer.upsertText(notePath, content);
    return { notePath, title, ...info };
  }
}

module.exports = {
  CODE_PLATFORM_MODES,
  CODE_PLATFORM_SERVICES,
  CodePlatformBookmarkStore,
  classifyCodePlatformUrl,
  codePlatformCoverage,
  normalizeAdditionalHosts,
  normalizeCodePlatformMode,
  normalizeCodeUrl,
  resourceLabel,
};
