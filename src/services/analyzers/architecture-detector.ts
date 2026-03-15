/**
 * Architectural Pattern Detector
 *
 * Detects high-level architectural patterns from file structure,
 * data models, endpoints, and import relationships.
 */

import type {
  AnalysisResult,
  CachedAnalysis,
  EndpointData,
  ModelData,
} from "../../interfaces/analysis.interface";

// ─── Types ───────────────────────────────────────────────────────

export interface ArchitecturalPattern {
  name: string;
  confidence: number; // 0.0 – 1.0
  indicators: string[];
  layers?: ArchitecturalLayer[];
}

export interface ArchitecturalLayer {
  name: string;
  directories: string[];
  fileCount: number;
}

export interface ArchitectureReport {
  patterns: ArchitecturalPattern[];
  entryPoints: string[];
  layerMap: ArchitecturalLayer[];
  projectType: string;
}

// ─── Constants ───────────────────────────────────────────────────

const LAYER_PATTERNS: Record<string, RegExp> = {
  controllers:
    /(?:^|[\\/])(?:controllers?|routes?|routers?|handlers?|endpoints?)[\\/]/i,
  services: /(?:^|[\\/])(?:services?|providers?|usecases?|interactors?)[\\/]/i,
  repositories:
    /(?:^|[\\/])(?:repositor(?:y|ies)|dao|data-access|stores?)[\\/]/i,
  models: /(?:^|[\\/])(?:models?|entities?|schemas?|types?)[\\/]/i,
  middleware:
    /(?:^|[\\/])(?:middlewar(?:e|es)|guards?|interceptors?|pipes?|filters?)[\\/]/i,
  views: /(?:^|[\\/])(?:views?|templates?|pages?|components?|screens?)[\\/]/i,
  config: /(?:^|[\\/])(?:config|configuration|settings|env)[\\/]/i,
  utils: /(?:^|[\\/])(?:utils?|helpers?|lib|common|shared)[\\/]/i,
  tests: /(?:^|[\\/])(?:tests?|__tests?__|spec|__spec__)[\\/]/i,
};

const ENTRY_POINT_PATTERNS = [
  // Level 0: root entry (index.ts, src/index.ts)
  /^(?:src[\/])?(?:index|main|app|server)\.(ts|js|tsx|jsx|py|go|rs|java|php)$/i,
  // Level 1: one prefix segment (myapp/src/index.ts, service/src/main.ts)
  /^[^\/]+[\/](?:src[\/])?(?:index|main|app|server)\.(ts|js|tsx|jsx|py|go|rs|java|php)$/i,
  // Level 2: two prefix segments — covers monorepo layouts (packages/api/src/index.ts)
  /^[^\/]+[\/][^\/]+[\/](?:src[\/])?(?:index|main|app|server)\.(ts|js|tsx|jsx|py|go|rs|java|php)$/i,
  // Bootstrap/startup variants (levels 0-2)
  /^(?:[^\/]+[\/]){0,2}(?:src[\/])?(?:bootstrap|startup|entry)\.(ts|js|py|go)$/i,
  // Django manage.py — always at root
  /^manage\.py$/i,
  // Go cmd pattern: cmd/<name>/main.go — exactly 3 segments
  /^cmd[\/][^\/]+[\/]main\.go$/i,
];

const PROJECT_TYPE_INDICATORS: Record<
  string,
  { files: RegExp[]; frameworks: string[] }
> = {
  "REST API": {
    files: [/controllers?[\\/]/i, /routes?[\\/]/i],
    frameworks: [
      "express",
      "fastify",
      "koa",
      "hono",
      "flask",
      "fastapi",
      "gin",
      "actix",
      "spring",
    ],
  },
  "Full-stack Web App": {
    files: [/pages?[\\/]/i, /components?[\\/]/i, /api[\\/]/i],
    frameworks: ["next", "nuxt", "sveltekit", "remix"],
  },
  "Frontend SPA": {
    files: [/components?[\\/]/i, /views?[\\/]/i],
    frameworks: ["react", "react-dom", "vue", "svelte", "@angular/core"],
  },
  "CLI Tool": {
    files: [/cmd[\\/]/i, /commands?[\\/]/i],
    frameworks: ["commander", "yargs", "clap", "cobra"],
  },
  "Library / SDK": {
    files: [/(?:^|[\\/])(?:src[\\/])?index\.(ts|js)$/i],
    frameworks: [],
  },
  Microservices: {
    files: [/services?[\\/].*[\\/]src[\\/]/i, /packages?[\\/]/i],
    frameworks: ["@nestjs/microservices", "grpc", "amqplib", "kafkajs"],
  },
};

// ─── Detector ────────────────────────────────────────────────────

export function detectArchitecture(
  analysis: AnalysisResult | CachedAnalysis,
): ArchitectureReport {
  const files = analysis.files || [];
  const frameworks = analysis.frameworks || [];
  const endpoints = analysis.apiEndpoints || [];
  const models = analysis.dataModels || [];

  const layerMap = detectLayers(files);
  const patterns = detectPatterns(
    layerMap,
    files,
    frameworks,
    endpoints,
    models,
  );
  const entryPoints = detectEntryPoints(files);
  const projectType = detectProjectType(files, frameworks);

  return { patterns, entryPoints, layerMap, projectType };
}

// ─── Layer Detection ─────────────────────────────────────────────

function detectLayers(files: string[]): ArchitecturalLayer[] {
  const layers: ArchitecturalLayer[] = [];

  for (const [name, pattern] of Object.entries(LAYER_PATTERNS)) {
    const matched: string[] = [];
    const dirs = new Set<string>();

    for (const f of files) {
      const m = f.match(pattern);
      if (m) {
        matched.push(f);
        dirs.add(f.slice(0, (m.index ?? 0) + m[0].length));
      }
    }

    if (matched.length > 0) {
      layers.push({
        name,
        directories: [...dirs],
        fileCount: matched.length,
      });
    }
  }

  return layers;
}

// ─── Pattern Detection ───────────────────────────────────────────

function detectPatterns(
  layers: ArchitecturalLayer[],
  files: string[],
  frameworks: string[],
  endpoints: EndpointData[],
  models: ModelData[],
): ArchitecturalPattern[] {
  const patterns: ArchitecturalPattern[] = [];
  const layerNames = new Set(layers.map((l) => l.name));

  // 1. Layered / Clean Architecture
  if (layerNames.has("controllers") && layerNames.has("services")) {
    const indicators = ["controllers/ directory", "services/ directory"];
    let confidence = 0.6;

    if (layerNames.has("repositories")) {
      indicators.push("repositories/ directory");
      confidence = 0.9;
    }
    if (layerNames.has("models")) {
      indicators.push("models/ directory");
      confidence = Math.min(confidence + 0.05, 1.0);
    }

    const detectedLayers = layers.filter((l) =>
      ["controllers", "services", "repositories", "models"].includes(l.name),
    );

    patterns.push({
      name: "Layered Architecture",
      confidence,
      indicators,
      layers: detectedLayers,
    });
  }

  // 2. MVC / MVVM
  if (
    layerNames.has("controllers") &&
    layerNames.has("models") &&
    layerNames.has("views")
  ) {
    patterns.push({
      name: "MVC",
      confidence: 0.85,
      indicators: [
        "controllers/ directory",
        "models/ directory",
        "views/ or pages/ directory",
      ],
    });
  } else if (layerNames.has("models") && layerNames.has("views")) {
    // Check for ViewModel pattern (MVVM)
    const hasViewModels = files.some(
      (f) => /view-?models?[\\/]/i.test(f) || /\.viewmodel\./i.test(f),
    );
    if (hasViewModels) {
      patterns.push({
        name: "MVVM",
        confidence: 0.8,
        indicators: [
          "models/ directory",
          "views/ directory",
          "viewmodel files detected",
        ],
      });
    }
  }

  // 3. Module-based / Feature-based organization
  const featureDirPattern =
    /(?:^|[\\/])(?:modules?|features?|domains?)[\\/]([^\\/]+)[\\/]/i;
  const featureNames = new Set<string>();
  for (const f of files) {
    const match = f.match(featureDirPattern);
    if (match) featureNames.add(match[1]);
  }
  if (featureNames.size >= 2) {
    patterns.push({
      name: "Module-based Organization",
      confidence: Math.min(0.5 + featureNames.size * 0.1, 0.95),
      indicators: [
        `${featureNames.size} feature modules: ${[...featureNames].slice(0, 5).join(", ")}`,
      ],
    });
  }

  // 4. Monorepo
  const packageDirs = files.filter((f) =>
    /(?:^|[\\/])(?:packages?|apps?|libs?)[\\/][^\\/]+[\\/]package\.json$/i.test(
      f,
    ),
  );
  if (packageDirs.length >= 2) {
    patterns.push({
      name: "Monorepo",
      confidence: Math.min(0.6 + packageDirs.length * 0.1, 0.95),
      indicators: [
        `${packageDirs.length} sub-packages detected`,
        ...packageDirs
          .slice(0, 3)
          .map((d) => d.replace(/[\\/]package\.json$/, "")),
      ],
    });
  }

  // 5. Event-driven / Message-based
  const eventIndicators: string[] = [];
  if (frameworks.some((f) => /kafka|rabbitmq|amqp|nats|redis/i.test(f))) {
    eventIndicators.push("message broker dependency");
  }
  if (
    files.some((f) =>
      /(?:events?|listeners?|subscribers?|handlers?)[\\/]/i.test(f),
    )
  ) {
    eventIndicators.push("event handler directories");
  }
  if (eventIndicators.length >= 1) {
    patterns.push({
      name: "Event-driven",
      confidence: Math.min(0.4 + eventIndicators.length * 0.25, 0.95),
      indicators: eventIndicators,
    });
  }

  // 6. Middleware pipeline
  if (layerNames.has("middleware") && endpoints.length > 0) {
    patterns.push({
      name: "Middleware Pipeline",
      confidence: 0.7,
      indicators: [
        "middleware/ directory",
        `${endpoints.length} API endpoints`,
      ],
    });
  }

  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);

  return patterns;
}

// ─── Entry Point Detection ───────────────────────────────────────

function detectEntryPoints(files: string[]): string[] {
  return files.filter((f) => ENTRY_POINT_PATTERNS.some((p) => p.test(f)));
}

// ─── Project Type Detection ──────────────────────────────────────

function detectProjectType(files: string[], frameworks: string[]): string {
  const scores: Record<string, number> = {};

  // Build lookup set once — O(n) instead of O(n²) repeated .includes()
  const frameworkSet = new Set(frameworks.map((f) => f.toLowerCase()));
  const WEB_FRAMEWORK_PATTERN =
    /^(?:express|fastify|react|react-dom|vue|svelte|@angular\/core|next|nuxt|remix|sveltekit|flask|fastapi|django|gin|actix|spring|koa|hono)$/i;
  // Iterate Set directly instead of spreading to an array
  let hasWebFramework = false;
  for (const f of frameworkSet) {
    if (WEB_FRAMEWORK_PATTERN.test(f)) {
      hasWebFramework = true;
      break;
    }
  }

  for (const [projectType, indicators] of Object.entries(
    PROJECT_TYPE_INDICATORS,
  )) {
    let score = 0;

    for (const pattern of indicators.files) {
      if (files.some((f) => pattern.test(f))) score += 1;
    }

    for (const fw of indicators.frameworks) {
      if (frameworkSet.has(fw.toLowerCase())) score += 2;
    }

    // Library / SDK: only claim it when no web-framework dependency exists
    if (projectType === "Library / SDK" && hasWebFramework) {
      score = 0;
    }

    if (score > 0) scores[projectType] = score;
  }

  // Stable sort: break ties alphabetically so result is deterministic
  const sorted = Object.entries(scores).sort(
    ([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB),
  );
  return sorted.length > 0 ? sorted[0][0] : "General Application";
}
