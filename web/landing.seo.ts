export const landingSeo = {
  siteUrl: "https://z3r0.fans/",
  siteName: "Z3r0",
  title: "Z3r0 - Intelligent Multi-agent Security Assessment Workbench",
  description:
    "Z3r0 is an open-source multi-agent security assessment workbench for intelligent, operator-guided automation of authorized penetration testing, vulnerability discovery, code auditing, and technical research, with graph-driven assignments, evidence chains, findings, attack paths, Docker sandboxes, controlled egress, and replayable timelines.",
  imagePath: "assets/z3r0-logo.png",
  imageAlt: "Z3r0 logo",
  keywords: [
    "Z3r0",
    "security assessment workbench",
    "multi-agent security assessment automation",
    "authorized penetration testing",
    "vulnerability discovery",
    "technical security research",
    "vulnerability validation",
    "security assessment orchestration",
    "attack path analysis",
    "attack path replay",
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
    "work project records",
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
          text: "Z3r0 is an open-source multi-agent security assessment workbench for intelligent, operator-guided automation of authorized penetration testing, vulnerability discovery, code auditing, and technical research.",
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
          text: "Z3r0 assumes that user-provided objectives, targets, and instructions are lawfully authorized for the active engagement. It grants no additional access rights; the active project scope and runtime controls define execution boundaries. Keep actions bounded and non-destructive. Operators remain responsible for applicable legal and contractual requirements; the author and maintainers accept no responsibility for damage, loss, claims, or liability arising from user deployment, configuration, instructions, conduct, or misuse.",
        },
      },
      {
        "@type": "Question",
        name: "How does Z3r0 handle authorization?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Z3r0 assumes that user-provided objectives and targets are lawfully authorized for the active engagement. The active project scope and runtime controls define execution boundaries; Z3r0 grants no additional access rights.",
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
