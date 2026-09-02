export const landingSeo = {
  siteUrl: "https://z3r0.fans/",
  siteName: "Z3r0",
  title: "Z3r0 - Security Assessment Workbench for Authorized Testing",
  description:
    "Z3r0 is an open-source security assessment workbench with graph-driven specialist assignments, attributable evidence chains, lead review, validated findings and assessment paths, distributed Docker sandboxes, controlled egress, and replayable timelines.",
  imagePath: "assets/z3r0-logo.png",
  imageAlt: "Z3r0 logo",
  keywords: [
    "Z3r0",
    "security assessment workbench",
    "multi-agent security assessment platform",
    "authorized security testing",
    "controlled vulnerability analysis",
    "technical security research",
    "vulnerability validation",
    "security assessment orchestration",
    "assessment path analysis",
    "assessment path replay",
    "sandboxed security tooling",
    "preloaded sandbox security tools",
    "distributed Docker sandbox",
    "sandbox skills",
    "controlled egress",
    "proxy egress",
    "targeted DNS diagnostics",
    "low-volume HTTP inspection",
    "reverse engineering sandbox",
    "binary diagnostics sandbox",
    "Ghidra sandbox",
    "evidence records",
    "asset relationship graph",
    "graph-driven assessment workflow",
    "security evidence chain",
    "WorkProject records",
    "code audit automation",
    "source code security audit",
    "dependency review",
    "security finding management",
    "agent orchestration",
    "reverse engineering automation",
    "cryptography review",
  ],
};

export const structuredData = [
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: landingSeo.siteName,
    applicationCategory: "SecurityApplication",
    operatingSystem: "Linux, Docker",
    url: landingSeo.siteUrl,
    image: new URL(landingSeo.imagePath, landingSeo.siteUrl).toString(),
    description: landingSeo.description,
    softwareRequirements: "Docker Engine, Docker Compose, PostgreSQL, model provider credentials",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    sameAs: ["https://github.com/yv1ing/Z3r0"],
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is Z3r0?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Z3r0 is an open-source security assessment workbench for authorized testing, vulnerability analysis, code auditing, and technical research.",
        },
      },
      {
        "@type": "Question",
        name: "Who is Z3r0 designed for?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Z3r0 is designed for internal security teams, authorized assessment practitioners, vulnerability researchers, code auditors, reverse engineers, cryptography reviewers, and controlled research environments.",
        },
      },
      {
        "@type": "Question",
        name: "How does Z3r0 run security tooling?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Z3r0 binds agent tools and manual review workflows to controlled Docker sandbox containers with command execution, file access, shell access, browser workflows, noVNC review, sandbox-local skills, controlled egress, targeted network diagnostics, local artifact triage, Android and firmware analysis, reverse engineering, binary diagnostics, and Python tasks.",
        },
      },
      {
        "@type": "Question",
        name: "What environments should use Z3r0?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Z3r0 is for lawful, explicitly authorized use in trusted, isolated environments. Any unauthorized, unlawful, or malicious attack, intrusion, compromise, disruption, or data activity is strictly prohibited. Confirm written scope, permitted methods, data handling, monitoring, stop conditions, and cleanup before work begins. Operators bear sole responsibility for applicable legal and contractual requirements; the author and maintainers accept no responsibility for any damage, loss, claim, or legal liability arising from user deployment, configuration, instructions, conduct, or unauthorized use.",
        },
      },
      {
        "@type": "Question",
        name: "What authorization is required?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Obtain prior written authorization from the system owner or engagement authority. Define the assets, methods, time window, data handling, monitoring, stop conditions, and cleanup. Z3r0 grants no permission to test third-party systems or data.",
        },
      },
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Z3r0",
        item: landingSeo.siteUrl,
      },
    ],
  },
];

export function getRobotsTxt() {
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${new URL("sitemap.xml", landingSeo.siteUrl).toString()}`,
    "",
  ].join("\n");
}

export function getSitemapXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <url>",
    `    <loc>${landingSeo.siteUrl}</loc>`,
    "    <changefreq>weekly</changefreq>",
    "    <priority>1.0</priority>",
    "  </url>",
    "</urlset>",
    "",
  ].join("\n");
}

export function getWebManifest(iconSrc: string) {
  return JSON.stringify(
    {
      name: "Z3r0",
      short_name: "Z3r0",
      description: landingSeo.description,
      start_url: "/",
      display: "standalone",
      background_color: "#090d16",
      theme_color: "#d92d3a",
      icons: [
        {
          src: iconSrc,
          sizes: "1000x1000",
          type: "image/png",
          purpose: "any",
        },
      ],
    },
    null,
    2,
  );
}
