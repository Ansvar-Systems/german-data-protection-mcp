#!/usr/bin/env node

/**
 * German Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying BfDI decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: de_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "german-data-protection-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "de_dp_search_decisions",
    description:
      "Full-text search across BfDI decisions (Bußgeldbescheide, Verfahren, Anordnungen). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited. Search in German for best results (e.g., 'Einwilligung', 'Videoüberwachung', 'Clearview').",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in German (e.g., 'Einwilligung Cookies', 'Beschäftigtendatenschutz', 'H&M')",
        },
        type: {
          type: "string",
          enum: ["bussgeld", "anordnung", "verfahren", "bescheid"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'einwilligung', 'videoüberwachung', 'beschaeftigtendatenschutz'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "de_dp_get_decision",
    description:
      "Get a specific BfDI decision by reference number (e.g., 'BFDI-2022-001', 'DSK-2021-003').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "BfDI decision reference number",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "de_dp_search_guidelines",
    description:
      "Search BfDI and DSK guidance documents: Orientierungshilfen, Kurzpapiere, Hinweise, and Empfehlungen. Covers DSGVO implementation, DSFA methodology, Beschäftigtendatenschutz, technische und organisatorische Maßnahmen, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in German (e.g., 'Datenschutz-Folgenabschätzung', 'Auftragsverarbeitung', 'technische Maßnahmen')",
        },
        type: {
          type: "string",
          enum: ["orientierungshilfe", "kurzpapier", "hinweis", "empfehlung"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'datenschutz_folgenabschaetzung', 'auftragsverarbeitung', 'cookies'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "de_dp_get_guideline",
    description:
      "Get a specific BfDI guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from de_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "de_dp_list_topics",
    description:
      "List all covered data protection topics with German and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "de_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "de_dp_list_sources",
    description:
      "List all data sources used by this MCP server, including publisher, URL, coverage scope, and license.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "de_dp_check_data_freshness",
    description:
      "Check when the corpus was last ingested, how many records exist, and whether the data may be stale.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

const META = {
  disclaimer:
    "Not legal advice. Data sourced from official BfDI and DSK publications. Verify all references against primary sources before making compliance decisions.",
  copyright: "BfDI / DSK — official German federal publications (public domain)",
  source_url: "https://www.bfdi.bund.de/",
} as const;

function buildMeta() {
  return { ...META, data_age: getDataAge() };
}

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
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

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
            "BfDI (Bundesbeauftragter für den Datenschutz und die Informationsfreiheit) MCP server. Provides access to German federal data protection authority decisions, sanctions, and official guidance documents including DSK (Datenschutzkonferenz) publications.",
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
