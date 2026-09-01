"use strict";

const DOCUMENT_SERVICES = {
  feishu: {
    name: "Feishu / Lark",
    loginUrl: "https://www.feishu.cn/",
    hosts: ["feishu.cn", "larksuite.com", "larkoffice.com"],
    contentSelectors: ["[data-testid='doc-content']", ".docx-content", ".suite-page-canvas", "[contenteditable='true']", "main", "body"],
    virtualDocument: {
      scrollSelectors: [".bear-web-x-container", ".suite-page-canvas", ".docx-content"],
      blockSelector: "[data-block-id]",
      blockIdAttribute: "data-block-id",
      blockTypeAttribute: "data-block-type",
      pageBlockType: "page",
      maxSteps: 2_400,
      maxHtmlChars: 16 * 1024 * 1024,
    },
  },
  tencent: {
    name: "Tencent Docs",
    loginUrl: "https://docs.qq.com/desktop/",
    hosts: ["docs.qq.com"],
    contentSelectors: [".editor-content", ".ql-editor", ".canvas-content", "[contenteditable='true']", "main", "body"],
  },
  wps: {
    name: "WPS Docs",
    loginUrl: "https://www.kdocs.cn/",
    hosts: ["kdocs.cn", "wps.cn"],
    contentSelectors: [".kdocs-reader-content", ".editor-container", "[contenteditable='true']", "main", "body"],
  },
};

const COMMON_REMOVE_SELECTORS = [
  "script", "style", "noscript", "template", "nav", "footer", "header[role='banner']",
  "[role='navigation']", "[aria-label*='cookie' i]", "[class*='advert' i]", "[class*='recommend' i]",
];

// A registry, rather than one-off conditions, keeps future community support
// data-only: declare hosts, detail paths, content roots, and comment roots.
const COMMUNITY_SERVICES = {
  reddit: {
    name: "Reddit", region: "international", api: "reddit", session: true,
    loginUrl: "https://www.reddit.com/login/", hosts: ["reddit.com", "redd.it"], paths: [/\/comments\//i, /^\/[a-z0-9]+\/?$/i],
    contentSelectors: ["main", "shreddit-post", "body"], commentSelectors: ["shreddit-comment", "[data-testid='comment']"],
    authPattern: "blocked by network security|log in to your reddit account|登录.*reddit",
  },
  producthunt: {
    name: "Product Hunt", region: "international", session: true,
    loginUrl: "https://www.producthunt.com/", hosts: ["producthunt.com"], paths: [/\/(?:posts|products|p|daily)\//i],
    contentSelectors: ["main", "[role='main']", "body"], commentSelectors: ["[data-test*='comment' i]", "[class*='comment' i]"],
    authPattern: "安全验证|security verification|verify you are human|sign in.*product hunt",
  },
  hackernews: {
    name: "Hacker News", region: "international", api: "hackernews",
    loginUrl: "https://news.ycombinator.com/", hosts: ["news.ycombinator.com"], paths: [/\/item/i],
    contentSelectors: ["table#hnmain", "body"], commentSelectors: ["tr.comtr"],
  },
  github: {
    name: "GitHub Issues / Discussions", region: "international", api: "github",
    loginUrl: "https://github.com/login", hosts: ["github.com"], paths: [/\/[^/]+\/[^/]+\/(?:issues|pull|discussions)\/\d+/i],
    contentSelectors: ["main", "[data-testid='issue-viewer']", ".repository-content", "body"],
    commentSelectors: [".timeline-comment", ".js-comment", ".comment-body", "[data-testid*='comment' i]"],
  },
  stackexchange: {
    name: "Stack Overflow / Stack Exchange", region: "international", api: "stackexchange",
    loginUrl: "https://stackoverflow.com/", hosts: ["stackoverflow.com", "stackexchange.com", "serverfault.com", "superuser.com", "askubuntu.com", "mathoverflow.net"], paths: [/\/questions\/\d+/i],
    contentSelectors: ["#mainbar", "#content", "main", "body"], commentSelectors: [".answer", ".comment-copy"],
  },
  devto: {
    name: "DEV / Forem", region: "international", api: "devto",
    loginUrl: "https://dev.to/", hosts: ["dev.to"], paths: [/^\/[^/]+\/[^/]+/i],
    contentSelectors: ["#article-show-container", "article", "main", "body"], commentSelectors: ["#comments-container .comment", ".comment"],
  },
  discourse: {
    name: "Discourse forums", region: "international", api: "discourse",
    loginUrl: "https://meta.discourse.org/", hosts: [
      "meta.discourse.org", "community.openai.com", "community.obsidian.md", "discuss.python.org",
      "users.rust-lang.org", "forums.swift.org", "discourse.julialang.org", "discuss.kotlinlang.org",
      "forum.djangoproject.com", "community.grafana.com", "discuss.elastic.co", "forum.arduino.cc",
    ], paths: [/\/t\//i], contentSelectors: ["#main-outlet", "#topic", "main", "body"], commentSelectors: [".topic-post", ".cooked"],
  },
  medium: {
    name: "Medium", region: "international", session: true,
    loginUrl: "https://medium.com/", hosts: ["medium.com"], paths: [/\/@?[^/]+\//i, /^\/[^/]+\/[a-z0-9-]+-[a-f0-9]+/i],
    contentSelectors: ["article", "main", "body"], commentSelectors: ["[aria-label*='response' i]", "[data-testid*='response' i]"],
    authPattern: "sign in.*medium|member-only story|create an account to read",
  },
  hashnode: {
    name: "Hashnode", region: "international", loginUrl: "https://hashnode.com/",
    hosts: ["hashnode.com", "hashnode.dev"], contentSelectors: ["article", "main", "body"],
    commentSelectors: ["[data-testid*='comment' i]", "[id*='comment' i]"],
  },
  substack: {
    name: "Substack", region: "international", loginUrl: "https://substack.com/",
    hosts: ["substack.com"], paths: [/\/p\//i], contentSelectors: ["article", ".post", "main", "body"],
    commentSelectors: ["[data-testid*='comment' i]", "[class*='comment' i]"],
  },
  lobsters: {
    name: "Lobsters", region: "international", loginUrl: "https://lobste.rs/",
    hosts: ["lobste.rs"], paths: [/\/s\//i], contentSelectors: ["#inside", "main", "body"], commentSelectors: [".comment"],
  },
  indiehackers: {
    name: "Indie Hackers", region: "international", loginUrl: "https://www.indiehackers.com/",
    hosts: ["indiehackers.com"], paths: [/\/(?:post|product)\//i], contentSelectors: ["main", "article", "body"], commentSelectors: ["[class*='comment' i]"],
  },
  huggingface: {
    name: "Hugging Face Discussions", region: "international", loginUrl: "https://huggingface.co/",
    hosts: ["huggingface.co"], paths: [/\/(?:spaces|datasets|models)\/[^/]+\/[^/]+\/discussions\/\d+/i],
    contentSelectors: ["main", "article", "body"], commentSelectors: ["[data-target*='comment' i]", "[class*='discussion' i]"],
  },
  kaggle: {
    name: "Kaggle Discussions", region: "international", loginUrl: "https://www.kaggle.com/discussions",
    hosts: ["kaggle.com"], paths: [/\/discussions\//i], contentSelectors: ["main", "article", "body"], commentSelectors: ["[class*='comment' i]", "[data-testid*='comment' i]"],
  },
  v2ex: {
    name: "V2EX", region: "china", api: "v2ex", loginUrl: "https://www.v2ex.com/",
    hosts: ["v2ex.com"], paths: [/\/t\/\d+/i], contentSelectors: ["#Main", "main", "body"], commentSelectors: [".cell[id^='r_']"],
  },
  juejin: {
    name: "掘金", region: "china", session: true, loginUrl: "https://juejin.cn/",
    hosts: ["juejin.cn"], paths: [/\/(?:post|pin)\/\d+/i], contentSelectors: [".article", "article", "main", "body"],
    commentSelectors: [".comment-list .comment-item", "[class*='comment-item' i]"], authPattern: "登录后继续|扫码登录|sign in.*juejin",
  },
  csdn: {
    name: "CSDN", region: "china", loginUrl: "https://www.csdn.net/",
    hosts: ["csdn.net"], paths: [/\/article\/details\/\d+/i], contentSelectors: ["#article_content", "article", "main", "body"], commentSelectors: [".comment-list-container", "[class*='comment-list' i]"],
  },
  cnblogs: {
    name: "博客园", region: "china", loginUrl: "https://www.cnblogs.com/",
    hosts: ["cnblogs.com"], paths: [/\/p\/\d+/i, /\/archive\/\d{4}\/\d{2}\/\d{2}\//i],
    contentSelectors: ["#cnblogs_post_body", "#post_detail", "article", "body"], commentSelectors: [".feedbackItem", "#blog-comments-placeholder"],
  },
  segmentfault: {
    name: "SegmentFault 思否", region: "china", loginUrl: "https://segmentfault.com/",
    hosts: ["segmentfault.com"], paths: [/\/(?:a|q)\/\d+/i], contentSelectors: ["article", ".article", "main", "body"], commentSelectors: [".comments", "[class*='comment' i]"],
  },
  oschina: {
    name: "开源中国", region: "china", loginUrl: "https://www.oschina.net/",
    hosts: ["oschina.net"], paths: [/\/(?:news|p|question|translate)\//i], contentSelectors: [".article-detail", "article", "main", "body"], commentSelectors: [".comment-list", "[class*='comment' i]"],
  },
  zhihu: {
    name: "知乎", region: "china", session: true, loginUrl: "https://www.zhihu.com/signin",
    hosts: ["zhihu.com"], paths: [/\/(?:question\/\d+\/answer\/\d+|p\/\d+)/i], contentSelectors: [".Post-RichTextContainer", ".QuestionAnswer-content", "article", "main", "body"],
    commentSelectors: [".Comments-container", ".CommentItem"], authPattern: "登录知乎|扫码登录|sign in.*zhihu",
  },
  sspai: {
    name: "少数派", region: "china", loginUrl: "https://sspai.com/",
    hosts: ["sspai.com"], paths: [/\/post\/\d+/i], contentSelectors: [".article-body", "article", "main", "body"], commentSelectors: [".comment-list", "[class*='comment' i]"],
  },
  infoq: {
    name: "InfoQ", region: "china", loginUrl: "https://www.infoq.cn/",
    hosts: ["infoq.cn", "infoq.com"], paths: [/\/(?:article|news|presentations)\//i], contentSelectors: [".article-content", "article", "main", "body"], commentSelectors: ["[class*='comment' i]"],
  },
  tencentcloud: {
    name: "腾讯云开发者社区", region: "china", loginUrl: "https://cloud.tencent.com/developer",
    hosts: ["cloud.tencent.com"], paths: [/\/developer\/(?:article|ask)\//i], contentSelectors: [".com-markdown-collpase", ".article-content", "article", "main", "body"], commentSelectors: [".comment-list", "[class*='comment' i]"],
  },
  aliyun: {
    name: "阿里云开发者社区", region: "china", loginUrl: "https://developer.aliyun.com/",
    hosts: ["developer.aliyun.com"], paths: [/\/(?:article|ask)\//i], contentSelectors: [".article-content", "article", "main", "body"], commentSelectors: ["[class*='comment' i]"],
  },
  fiftyonecto: {
    name: "51CTO", region: "china", loginUrl: "https://www.51cto.com/",
    hosts: ["51cto.com"], paths: [/\/article\/\d+/i, /\/posts\/\d+/i], contentSelectors: [".article-content", "article", "main", "body"], commentSelectors: [".comment-list", "[class*='comment' i]"],
  },
  gitee: {
    name: "Gitee Issues", region: "china", loginUrl: "https://gitee.com/login",
    hosts: ["gitee.com"], paths: [/\/[^/]+\/[^/]+\/(?:issues|pulls)\/[a-z0-9]+/i], contentSelectors: ["main", ".project-content", "body"], commentSelectors: [".comment", "[class*='note' i]"],
  },
  gitcode: {
    name: "GitCode", region: "china", loginUrl: "https://gitcode.com/",
    hosts: ["gitcode.com"], paths: [/\/(?:issues|merge_requests)\//i], contentSelectors: ["main", ".detail-page", "body"], commentSelectors: ["[class*='comment' i]", "[class*='discussion' i]"],
  },
};

for (const service of Object.values(COMMUNITY_SERVICES)) {
  service.removeSelectors = [...COMMON_REMOVE_SELECTORS, ...(service.removeSelectors || [])];
}

const RENDER_SERVICES = { ...DOCUMENT_SERVICES, ...COMMUNITY_SERVICES };

function hostMatches(hostname, suffix) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const target = String(suffix || "").toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

function pathMatches(pathname, patterns = []) {
  return !patterns.length || patterns.some((pattern) => pattern.test(pathname));
}

function serviceForUrl(value, registry) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  for (const [id, service] of Object.entries(registry)) {
    if (service.hosts.some((host) => hostMatches(url.hostname, host)) && pathMatches(url.pathname, service.paths)) return id;
  }
  return null;
}

function documentServiceForUrl(value) {
  return serviceForUrl(value, DOCUMENT_SERVICES);
}

function communityServiceForUrl(value) {
  return serviceForUrl(value, COMMUNITY_SERVICES);
}

function isProductHuntUrl(value) {
  return communityServiceForUrl(value) === "producthunt";
}

function isRedditUrl(value) {
  return communityServiceForUrl(value) === "reddit";
}

function isLikelyPdfUrl(value) {
  try {
    const url = new URL(value);
    return /\.pdf$/i.test(url.pathname) || /(?:^|[?&])(?:format|type)=pdf(?:&|$)/i.test(url.search);
  } catch (_) { return false; }
}

function renderServiceForUrl(value) {
  return documentServiceForUrl(value) || communityServiceForUrl(value);
}

function communityCoverage(region) {
  return Object.entries(COMMUNITY_SERVICES)
    .filter(([, service]) => !region || service.region === region)
    .map(([id, service]) => ({ id, name: service.name, api: service.api || "rendered" }));
}

module.exports = {
  COMMUNITY_SERVICES,
  DOCUMENT_SERVICES,
  RENDER_SERVICES,
  communityCoverage,
  communityServiceForUrl,
  documentServiceForUrl,
  hostMatches,
  isLikelyPdfUrl,
  isProductHuntUrl,
  isRedditUrl,
  renderServiceForUrl,
  serviceForUrl,
};
