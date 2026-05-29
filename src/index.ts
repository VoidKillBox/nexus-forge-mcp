import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import archiver from "archiver";
import * as crypto from "crypto";

// ─── Constants & Directory Setup ──────────────────────────────────────────

const CACHE_DIR = path.join(os.homedir(), ".config", "nexus-forge-mcp");
const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
const CONFIG_FILE = path.join(CACHE_DIR, "config.json");

const GITHUB_TOKEN: string = process.env.GITHUB_TOKEN || "";

// Bootstrap runtime directories
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Auto-scaffold config on first launch
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        repositories: [
          {
            name: "antigravity-skills",
            bundlesUrl:
              "https://raw.githubusercontent.com/antigravity-ide/awesome-antigravity-skills/main/bundles.json",
            rawContentBase:
              "https://raw.githubusercontent.com/antigravity-ide/awesome-antigravity-skills/main/skills/",
          },
        ],
      },
      null,
      2
    ),
    "utf-8"
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface Repository {
  name: string;
  bundlesUrl: string;
  rawContentBase: string;
}

interface Bundle {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  files: string[];
}

interface CacheStructure {
  etags: Record<string, string>;
  manifests: Record<string, Bundle[]>;
}

// ─── Config / Cache Helpers ────────────────────────────────────────────────

function loadConfig(): Repository[] {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")).repositories;
}

function loadCache(): CacheStructure {
  if (!fs.existsSync(CACHE_FILE)) return { etags: {}, manifests: {} };
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return { etags: {}, manifests: {} };
  }
}

function saveCacheSync(cache: CacheStructure): void {
  const tempFile: string = `${CACHE_FILE}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf-8");
  fs.renameSync(tempFile, CACHE_FILE);
}

// ─── HTTP Helpers ──────────────────────────────────────────────────────────

function getBaseHeaders(
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "NexusForge-MCP",
    ...extraHeaders,
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

// ─── Scoring Engine (Keyword Density) ──────────────────────────────────────
// Localised keyword overlap with stop-word filtering and length normalisation.
// Each content word (>3 chars, not a stop-word) matching the bundle earns +10
// normalised by log2(query length). Explicit requirement tag hits earn +25.

const STOP_WORDS: Set<string> = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can",
  "had", "her", "was", "one", "our", "out", "has", "have", "been",
  "some", "with", "from", "that", "this", "they", "what", "when",
  "where", "which", "will", "your", "about", "into", "than", "then",
  "also", "just", "like", "more", "over", "such", "them", "very",
  "would", "could", "should",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w: string) => w.length > 3 && !STOP_WORDS.has(w));
}

function scoreBundle(
  bundle: Bundle,
  description: string,
  requirements: string[] = [],
): number {
  const targetTokens: string[] = tokenize(
    `${description} ${requirements.join(" ")}`,
  );
  const bundleTokens: string[] = tokenize(
    `${bundle.name} ${bundle.description || ""} ${(bundle.tags || []).join(" ")}`,
  );

  const bundleTokenSet: Set<string> = new Set(bundleTokens);
  const overlaps: number = targetTokens.filter((t: string) =>
    bundleTokenSet.has(t),
  ).length;
  const normaliser: number = Math.max(1, Math.log2(targetTokens.length + 1));
  let score: number = Math.round((overlaps / normaliser) * 10);

  // Bonus for explicit requirement tag matches
  if (requirements.length > 0 && bundle.tags) {
    const tagSet: Set<string> = new Set(
      bundle.tags.map((t: string) => t.toLowerCase()),
    );
    for (const req of requirements) {
      if (tagSet.has(req.toLowerCase())) score += 25;
    }
  }

  return score;
}

// ─── Manifest Fetching (ETag-Validated) ────────────────────────────────────

async function fetchLatestManifests(
  cache: CacheStructure,
  repos: Repository[],
): Promise<Bundle[]> {
  const cumulativeBundles: Bundle[] = [];
  let cacheUpdated = false;

  for (const repo of repos) {
    const headers: Record<string, string> = getBaseHeaders();
    if (cache.etags[repo.name]) {
      headers["If-None-Match"] = cache.etags[repo.name];
    }

    try {
      const res: Response = await fetch(repo.bundlesUrl, { headers });

      if (res.status === 304 && cache.manifests[repo.name]) {
        // Not modified — use cached manifest
        cumulativeBundles.push(...cache.manifests[repo.name]);
      } else if (res.ok) {
        // Fresh data received
        const data: any = await res.json();
        const newEtag: string | null = res.headers.get("ETag");
        cache.manifests[repo.name] = (data.bundles || []) as Bundle[];
        if (newEtag) cache.etags[repo.name] = newEtag;
        cumulativeBundles.push(...(data.bundles || []));
        cacheUpdated = true;
      } else {
        // HTTP error — log degradation, fall back to cache
        console.error(
          `[WARN] Repository fetch failed for ${repo.name} (HTTP ${res.status}). Using stale cache.`,
        );
        if (cache.manifests[repo.name]) {
          cumulativeBundles.push(...cache.manifests[repo.name]);
        }
      }
    } catch (err: unknown) {
      // Network-level error
      const msg: string =
        err instanceof Error ? err.message : String(err);
      console.error(
        `[WARN] Network error fetching ${repo.name}: ${msg}. Falling back to stale cache.`,
      );
      if (cache.manifests[repo.name]) {
        cumulativeBundles.push(...cache.manifests[repo.name]);
      }
    }
  }

  if (cacheUpdated) saveCacheSync(cache);
  return cumulativeBundles;
}

// ─── MCP Schemas ───────────────────────────────────────────────────────────

const DiscoverBundlesSchema = z.object({
  category: z
    .string()
    .optional()
    .describe("Filter specific capability domains like 'frontend', 'security'"),
});

const AnalyzeAndRankSchema = z.object({
  projectDescription: z
    .string()
    .describe("Details of the target project to map skills against"),
  requirements: z
    .array(z.string())
    .optional()
    .describe("Explicit tool/skill requirements (e.g., 'python', 'docker')"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe("Maximum ranked recommendations to return (1-50)"),
});

const PackageBundleSchema = z.object({
  bundleId: z
    .string()
    .describe("The exact bundle configuration identity to package"),
  projectName: z
    .string()
    .describe("Target name for generating the localized directory structure"),
  outputFormat: z
    .enum(["zip", "tar"])
    .default("zip")
    .describe("Desired layout serialization format"),
});

// ─── MCP Server Bootstrap ──────────────────────────────────────────────────

const server = new Server(
  { name: "nexus-forge-mcp", version: "2.2.0" },
  { capabilities: { tools: {} } },
);

// ─── Tool Registration ─────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "discover_bundles",
      description:
        "List all available bundles from tracked repositories, with optional category filter.",
      inputSchema: zodToJsonSchema(DiscoverBundlesSchema),
    },
    {
      name: "analyze_and_rank_skills",
      description:
        "Localised keyword density scoring engine. Scores and ranks remote skill " +
        "bundles against a project description, applying stop-word filtering and " +
        "length normalisation. Returns top N recommendations.",
      inputSchema: zodToJsonSchema(AnalyzeAndRankSchema),
    },
    {
      name: "package_bundle",
      description:
        "Downloads the files for a selected bundle, isolates them inside a " +
        "<project_name>/.skills/ directory, and compresses the result into a .zip " +
        "or .tar.gz archive for JIT deployment.",
      inputSchema: zodToJsonSchema(PackageBundleSchema),
    },
  ],
}));

// ─── Tool Handlers ─────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const cache: CacheStructure = loadCache();
  const trackedRepos: Repository[] = loadConfig();

  try {
    // ── discover_bundles ──────────────────────────────────
    if (name === "discover_bundles") {
      const parsed = DiscoverBundlesSchema.parse(args);
      let bundles: Bundle[] = await fetchLatestManifests(cache, trackedRepos);
      if (parsed.category) {
        const cat: string = parsed.category.toLowerCase();
        bundles = bundles.filter(
          (b: Bundle) => b.category?.toLowerCase() === cat,
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(bundles, null, 2) }],
      };
    }

    // ── analyze_and_rank_skills ───────────────────────────
    if (name === "analyze_and_rank_skills") {
      const parsed = AnalyzeAndRankSchema.parse(args);
      const allBundles: Bundle[] = await fetchLatestManifests(
        cache,
        trackedRepos,
      );
      const reqs: string[] = parsed.requirements || [];

      const ranked: any[] = allBundles
        .map((bundle: Bundle) => ({
          ...bundle,
          matchScore: scoreBundle(bundle, parsed.projectDescription, reqs),
        }))
        .filter((b: any) => b.matchScore > 0)
        .sort((a: any, b: any) => b.matchScore - a.matchScore)
        .slice(0, parsed.maxResults);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                analysis: "Ranked via keyword density alignment.",
                queryParams: {
                  descriptionLength: parsed.projectDescription.length,
                  requirements: reqs,
                },
                totalBundlesScored: allBundles.length,
                recommendations: ranked,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // ── package_bundle ────────────────────────────────────
    if (name === "package_bundle") {
      const parsed = PackageBundleSchema.parse(args);
      let matchedBundle: Bundle | undefined;
      let matchingRepo: Repository | undefined;

      for (const repo of trackedRepos) {
        const bundles: Bundle[] = cache.manifests[repo.name] || [];
        matchedBundle = bundles.find(
          (b: Bundle) => b.id === parsed.bundleId,
        );
        if (matchedBundle) {
          matchingRepo = repo;
          break;
        }
      }

      if (!matchedBundle || !matchingRepo) {
        throw new Error(
          `Bundle '${parsed.bundleId}' not found in any tracked repository cache. ` +
            `Run discover_bundles or analyze_and_rank_skills first.`,
        );
      }

      const hash: string = crypto.randomBytes(4).toString("hex");
      const baseDir: string = path.join(
        process.cwd(),
        `${parsed.projectName}_${hash}`,
      );
      const skillsDir: string = path.join(baseDir, ".skills");
      fs.mkdirSync(skillsDir, { recursive: true });

      try {
        // Sparse download — only the files listed in the bundle manifest
        for (const skillFile of matchedBundle.files) {
          const targetUrl: string = `${matchingRepo.rawContentBase}${skillFile}`;
          const destPath: string = path.join(skillsDir, skillFile);

          // Support nested file paths (e.g. "tools/scanner/index.ts")
          fs.mkdirSync(path.dirname(destPath), { recursive: true });

          const res: Response = await fetch(targetUrl, {
            headers: getBaseHeaders(),
          });
          if (!res.ok) {
            throw new Error(
              `Download failed: ${targetUrl} (HTTP ${res.status})`,
            );
          }
          fs.writeFileSync(destPath, await res.text(), "utf-8");
        }

        // Compress into archive
        const ext: string = parsed.outputFormat === "zip" ? "zip" : "tar";
        const outPath: string = path.join(
          process.cwd(),
          `${parsed.projectName}_${hash}.${ext}`,
        );
        const outStream: fs.WriteStream = fs.createWriteStream(outPath);
        const archive: archiver.Archiver = archiver(
          parsed.outputFormat,
          parsed.outputFormat === "tar" ? { gzip: true } : {},
        );

        await new Promise<void>((resolve, reject) => {
          outStream.on("close", resolve);
          archive.on("error", reject);
          archive.pipe(outStream);
          archive.directory(baseDir, false);
          archive.finalize();
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "SUCCESS",
                  bundleId: parsed.bundleId,
                  packagePath: outPath,
                  sourceRepo: matchingRepo.name,
                  loadedSkills: matchedBundle.files,
                  temporaryWorkspaceCleaned: true,
                },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        // Atomic cleanup — always remove working directory
        if (fs.existsSync(baseDir)) {
          fs.rmSync(baseDir, { recursive: true, force: true });
        }
      }
    }

    throw new Error(`Unknown tool execution vector: '${name}'`);
  } catch (err: unknown) {
    const message: string =
      err instanceof Error ? err.message : "An unknown error occurred";
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
});

// ─── Start Server ──────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[*] Nexus Forge MCP v2.2.0 server active on Stdio.");
