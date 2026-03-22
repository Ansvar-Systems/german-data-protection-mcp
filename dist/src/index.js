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
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { searchDecisions, getDecision, searchGuidelines, getGuideline, listTopics, } from "./db.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let pkgVersion = "0.1.0";
try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    pkgVersion = pkg.version;
}
catch {
    // fallback to default
}
const SERVER_NAME = "german-data-protection-mcp";
// --- Tool definitions ---------------------------------------------------------
const TOOLS = [
    {
        name: "de_dp_search_decisions",
        description: "Full-text search across BfDI decisions (Bußgeldbescheide, Verfahren, Anordnungen). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited. Search in German for best results (e.g., 'Einwilligung', 'Videoüberwachung', 'Clearview').",
        inputSchema: {
            type: "object",
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
        description: "Get a specific BfDI decision by reference number (e.g., 'BFDI-2022-001', 'DSK-2021-003').",
        inputSchema: {
            type: "object",
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
        description: "Search BfDI and DSK guidance documents: Orientierungshilfen, Kurzpapiere, Hinweise, and Empfehlungen. Covers DSGVO implementation, DSFA methodology, Beschäftigtendatenschutz, technische und organisatorische Maßnahmen, and more.",
        inputSchema: {
            type: "object",
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
        description: "Get a specific BfDI guidance document by its database ID.",
        inputSchema: {
            type: "object",
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
        description: "List all covered data protection topics with German and English names. Use topic IDs to filter decisions and guidelines.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    {
        name: "de_dp_about",
        description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
        inputSchema: {
            type: "object",
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
function textContent(data) {
    return {
        content: [
            { type: "text", text: JSON.stringify(data, null, 2) },
        ],
    };
}
function errorContent(message) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
    };
}
// --- Server setup ------------------------------------------------------------
const server = new Server({ name: SERVER_NAME, version: pkgVersion }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
        switch (name) {
            case "de_dp_search_decisions": {
                const parsed = SearchDecisionsArgs.parse(args);
                const results = searchDecisions({
                    query: parsed.query,
                    type: parsed.type,
                    topic: parsed.topic,
                    limit: parsed.limit,
                });
                return textContent({ results, count: results.length });
            }
            case "de_dp_get_decision": {
                const parsed = GetDecisionArgs.parse(args);
                const decision = getDecision(parsed.reference);
                if (!decision) {
                    return errorContent(`Decision not found: ${parsed.reference}`);
                }
                return textContent(decision);
            }
            case "de_dp_search_guidelines": {
                const parsed = SearchGuidelinesArgs.parse(args);
                const results = searchGuidelines({
                    query: parsed.query,
                    type: parsed.type,
                    topic: parsed.topic,
                    limit: parsed.limit,
                });
                return textContent({ results, count: results.length });
            }
            case "de_dp_get_guideline": {
                const parsed = GetGuidelineArgs.parse(args);
                const guideline = getGuideline(parsed.id);
                if (!guideline) {
                    return errorContent(`Guideline not found: id=${parsed.id}`);
                }
                return textContent(guideline);
            }
            case "de_dp_list_topics": {
                const topics = listTopics();
                return textContent({ topics, count: topics.length });
            }
            case "de_dp_about": {
                return textContent({
                    name: SERVER_NAME,
                    version: pkgVersion,
                    description: "BfDI (Bundesbeauftragter für den Datenschutz und die Informationsfreiheit) MCP server. Provides access to German federal data protection authority decisions, sanctions, and official guidance documents including DSK (Datenschutzkonferenz) publications.",
                    data_source: "BfDI (https://www.bfdi.bund.de/) and DSK (https://www.datenschutzkonferenz-online.de/)",
                    coverage: {
                        decisions: "BfDI Bußgeldbescheide, Anordnungen, and enforcement proceedings",
                        guidelines: "BfDI and DSK Orientierungshilfen, Kurzpapiere, Hinweise, and Empfehlungen",
                        topics: "Beschäftigtendatenschutz, Datenübermittlung, Einwilligung, Videoüberwachung, Gesundheitsdaten, DSFA, Auftragsverarbeitung, Cookies, Betroffenenrechte",
                    },
                    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
                });
            }
            default:
                return errorContent(`Unknown tool: ${name}`);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorContent(`Error executing ${name}: ${message}`);
    }
});
// --- Main --------------------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}
main().catch((err) => {
    process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
