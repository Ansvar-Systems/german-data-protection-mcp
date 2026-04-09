#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  getDataAge,
  getRecordCounts,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "german-data-protection-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "de_dp_search_decisions",
    description:
      "Full-text search across BfDI decisions (Bußgeldbescheide, Verfahren, Anordnungen). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited. Search in German for best results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in German (e.g., 'Einwilligung Cookies', 'H&M')" },
        type: {
          type: "string",
          enum: ["bussgeld", "anordnung", "verfahren", "bescheid"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "de_dp_get_decision",
    description: "Get a specific BfDI decision by reference number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "BfDI decision reference number" },
      },
      required: ["reference"],
    },
  },
  {
    name: "de_dp_search_guidelines",
    description:
      "Search BfDI and DSK guidance documents: Orientierungshilfen, Kurzpapiere, Hinweise, and Empfehlungen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in German" },
        type: {
          type: "string",
          enum: ["orientierungshilfe", "kurzpapier", "hinweis", "empfehlung"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "de_dp_get_guideline",
    description: "Get a specific BfDI guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "de_dp_list_topics",
    description: "List all covered data protection topics with German and English names.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "de_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "de_dp_list_sources",
    description:
      "List all data sources used by this MCP server, including publisher, URL, coverage scope, and license.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "de_dp_check_data_freshness",
    description:
      "Check when the corpus was last ingested, how many records exist, and whether the data may be stale.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["bussgeld", "anordnung", "verfahren", "bescheid"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["orientierungshilfe", "kurzpapier", "hinweis", "empfehlung"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- Shared helpers ----------------------------------------------------------

const META = {
  disclaimer:
    "Not legal advice. Data sourced from official BfDI and DSK publications. Verify all references against primary sources before making compliance decisions.",
  copyright: "BfDI / DSK — official German federal publications (public domain)",
  source_url: "https://www.bfdi.bund.de/",
} as const;

function buildMeta() {
  return { ...META, data_age: getDataAge() };
}

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string, errorType: string = "execution_error") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message, _error_type: errorType }, null, 2),
          },
        ],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "de_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const raw = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          const results = raw.map((d) => ({
            ...d,
            _citation: buildCitation(
              d.reference,
              d.title,
              "de_dp_get_decision",
              { reference: d.reference },
            ),
          }));
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "de_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.reference}`, "not_found");
          }
          const d = decision as unknown as Record<string, unknown>;
          return textContent({
            ...decision,
            _citation: buildCitation(
              String(d.reference ?? parsed.reference),
              String(d.title ?? d.reference ?? parsed.reference),
              "de_dp_get_decision",
              { reference: parsed.reference },
              d.url as string | undefined,
            ),
            _meta: buildMeta(),
          });
        }

        case "de_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const raw = searchGuidelines({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          const results = raw.map((g) => ({
            ...g,
            _citation: buildCitation(
              String(g.reference ?? g.title ?? `Guideline #${g.id}`),
              g.title,
              "de_dp_get_guideline",
              { id: String(g.id) },
            ),
          }));
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "de_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) {
            return errorContent(`Guideline not found: id=${parsed.id}`, "not_found");
          }
          const g = guideline as unknown as Record<string, unknown>;
          return textContent({
            ...guideline,
            _citation: buildCitation(
              String(g.reference ?? g.title ?? `Guideline #${parsed.id}`),
              String(g.title ?? g.reference ?? `Guideline #${parsed.id}`),
              "de_dp_get_guideline",
              { id: String(parsed.id) },
              g.url as string | undefined,
            ),
            _meta: buildMeta(),
          });
        }

        case "de_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length, _meta: buildMeta() });
        }

        case "de_dp_about": {
          const counts = getRecordCounts();
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "BfDI (Bundesbeauftragter für den Datenschutz und die Informationsfreiheit) MCP server. Provides access to German federal data protection authority decisions, sanctions, and official guidance documents.",
            data_source: "BfDI (https://www.bfdi.bund.de/) and DSK (https://www.datenschutzkonferenz-online.de/)",
            coverage: {
              decisions: counts.decisions,
              guidelines: counts.guidelines,
              topics: counts.topics,
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: buildMeta(),
          });
        }

        case "de_dp_list_sources": {
          return textContent({
            sources: [
              {
                id: "bfdi",
                name: "BfDI — Bundesbeauftragter für den Datenschutz und die Informationsfreiheit",
                url: "https://www.bfdi.bund.de/",
                type: "regulatory_authority",
                coverage: "Decisions, sanctions, Bußgeldbescheide, Anordnungen, enforcement proceedings",
                language: "de",
                license: "Public domain — official German federal publications",
              },
              {
                id: "dsk",
                name: "DSK — Datenschutzkonferenz",
                url: "https://www.datenschutzkonferenz-online.de/",
                type: "conference_body",
                coverage: "Orientierungshilfen, Kurzpapiere, Hinweise, Empfehlungen on DSGVO implementation",
                language: "de",
                license: "Public domain — official publications",
              },
            ],
            count: 2,
            last_ingested: "2026-03-23",
            _meta: buildMeta(),
          });
        }

        case "de_dp_check_data_freshness": {
          const counts = getRecordCounts();
          const dataAge = getDataAge();
          const ageDays = Math.floor(
            (Date.now() - new Date(dataAge).getTime()) / 86_400_000,
          );
          return textContent({
            status: ageDays > 30 ? "stale" : "fresh",
            last_ingested: "2026-03-23",
            last_data_date: dataAge,
            age_days: ageDays,
            record_counts: counts,
            freshness_note:
              ageDays > 30
                ? "Data may be outdated. Check BfDI website for recent decisions and guidance."
                : "Data is reasonably current.",
            sources: [
              "https://www.bfdi.bund.de/",
              "https://www.datenschutzkonferenz-online.de/",
            ],
            _meta: buildMeta(),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`, "unknown_tool");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorType = err instanceof z.ZodError ? "validation_error" : "execution_error";
      return errorContent(`Error executing ${name}: ${message}`, errorType);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
