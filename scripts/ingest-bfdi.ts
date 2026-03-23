/**
 * BfDI Ingestion Crawler
 *
 * Scrapes the BfDI website (bfdi.bund.de) and DSK website
 * (datenschutzkonferenz-online.de) for:
 *   - Enforcement decisions (Bußgeldbescheide, Anordnungen)
 *   - Guidance documents (Orientierungshilfen, Kurzpapiere, Hinweise)
 *   - Topic taxonomy
 *
 * Populates the SQLite database used by the BfDI MCP server.
 *
 * Usage:
 *   npx tsx scripts/ingest-bfdi.ts
 *   npx tsx scripts/ingest-bfdi.ts --force      # drop and recreate DB
 *   npx tsx scripts/ingest-bfdi.ts --resume     # resume from last checkpoint
 *   npx tsx scripts/ingest-bfdi.ts --dry-run    # log without writing to DB
 *
 * Prerequisites:
 *   npm install cheerio   (if not already installed)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";
import * as cheerio from "cheerio";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["BFDI_DB_PATH"] ?? "data/bfdi.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const REQUEST_DELAY_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const BFDI_BASE = "https://www.bfdi.bund.de";
const DSK_BASE = "https://www.datenschutzkonferenz-online.de";

// Press release listing — paginated, 50 per page
const PM_LIST_URL = `${BFDI_BASE}/DE/BfDI/Presse/Pressemitteilungen/pressemitteilungen_node.html`;
// Expert search for fine-related press releases
const PM_SEARCH_URL = `${BFDI_BASE}/SiteGlobals/Forms/Suche/Expertensuche_Formular.html`;
// DSK Orientierungshilfen table
const OH_TABLE_URL = `${BFDI_BASE}/DE/Fachthemen/Gremienarbeit/Datenschutzkonferenz/DSK-tableOrientierungshilfe.html`;
// DSK Kurzpapiere
const KP_LIST_URL = `${DSK_BASE}/kurzpapiere.html`;
// DSK Orientierungshilfen
const DSK_OH_URL = `${DSK_BASE}/orientierungshilfen.html`;
// DSK Beschluesse
const DSK_BESCHLUESSE_URL = `${DSK_BASE}/beschluesse-dsk.html`;

// Search terms for finding enforcement-related press releases
const ENFORCEMENT_SEARCH_TERMS = [
  "Geldbuße",
  "Bußgeld",
  "Anordnung",
  "verhängt",
  "Sanktion",
  "Verwarnung",
];

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const force = args.includes("--force");
const resume = args.includes("--resume");
const dryRun = args.includes("--dry-run");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProgressState {
  phase: string;
  completedUrls: string[];
  decisionsIngested: number;
  guidelinesIngested: number;
  topicsIngested: number;
  lastUpdated: string;
}

interface ScrapedDecision {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string | null;
  full_text: string;
  topics: string; // JSON array
  gdpr_articles: string; // JSON array
  status: string;
}

interface ScrapedGuideline {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string | null;
  full_text: string;
  topics: string; // JSON array
  language: string;
}

interface ListingEntry {
  title: string;
  url: string;
  date: string | null;
  type?: string;
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function loadProgress(): ProgressState {
  if (resume && existsSync(PROGRESS_FILE)) {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      const state = JSON.parse(raw) as ProgressState;
      console.log(`Resuming from checkpoint: ${state.phase} (${state.completedUrls.length} URLs done)`);
      return state;
    } catch {
      console.warn("Could not parse progress file, starting fresh");
    }
  }
  return {
    phase: "init",
    completedUrls: [],
    decisionsIngested: 0,
    guidelinesIngested: 0,
    topicsIngested: 0,
    lastUpdated: new Date().toISOString(),
  };
}

function saveProgress(state: ProgressState): void {
  if (dryRun) return;
  state.lastUpdated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "AnsvarBfDICrawler/1.0 (+https://ansvar.eu; data-protection-research)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        console.warn(`  Attempt ${attempt}/${retries} failed for ${url}: ${message}`);
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw new Error(`Failed after ${retries} attempts: ${url} — ${message}`);
      }
    }
  }
  throw new Error("Unreachable");
}

async function fetchHtml(url: string): Promise<cheerio.CheerioAPI> {
  const html = await fetchWithRetry(url);
  return cheerio.load(html);
}

/**
 * Fetch and extract text from a PDF URL.
 * Returns a basic text representation — PDFs are stored as-is
 * since full PDF parsing would require additional dependencies.
 * We store the download URL and title instead.
 */
async function fetchPdfInfo(url: string): Promise<{ available: boolean; url: string }> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "AnsvarBfDICrawler/1.0 (+https://ansvar.eu; data-protection-research)",
      },
    });
    return { available: response.ok, url };
  } catch {
    return { available: false, url };
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function resolveUrl(base: string, href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  if (href.startsWith("//")) {
    return "https:" + href;
  }
  if (href.startsWith("/")) {
    const origin = new URL(base).origin;
    return origin + href;
  }
  // Relative path
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/[^/]*$/, "/");
  return baseUrl.origin + basePath + href;
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/** Parse German date formats: "01.10.2020", "Oktober 2020", "2020-10-01" */
function parseDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;

  const trimmed = dateStr.trim();

  // ISO format already
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // German DD.MM.YYYY
  const dotMatch = trimmed.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // "Monat YYYY" or "YYYY"
  const germanMonths: Record<string, string> = {
    januar: "01", februar: "02", "märz": "03", april: "04",
    mai: "05", juni: "06", juli: "07", august: "08",
    september: "09", oktober: "10", november: "11", dezember: "12",
    jan: "01", feb: "02", "mär": "03", apr: "04",
    jun: "06", jul: "07", aug: "08", sep: "09",
    okt: "10", nov: "11", dez: "12",
  };

  const monthMatch = trimmed.toLowerCase().match(/(\w+)\s+(\d{4})/);
  if (monthMatch) {
    const [, monthName, year] = monthMatch;
    const monthNum = germanMonths[monthName!];
    if (monthNum) {
      return `${year}-${monthNum}-01`;
    }
  }

  // Year only
  const yearMatch = trimmed.match(/^(\d{4})$/);
  if (yearMatch) {
    return `${yearMatch[1]}-01-01`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

/** Extract GDPR article references from German text */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // "Art. 5", "Art. 28", "Artikel 35"
  const artMatches = text.matchAll(/Art(?:ikel)?\.?\s*(\d+)/gi);
  for (const m of artMatches) {
    const num = m[1]!;
    const n = parseInt(num, 10);
    // GDPR has 99 articles
    if (n >= 1 && n <= 99) {
      articles.add(num);
    }
  }

  // "§ 26 BDSG" style — store as "§26-BDSG"
  const bdsgMatches = text.matchAll(/§\s*(\d+[a-z]?)\s*(?:Abs\.\s*\d+\s*)?BDSG/gi);
  for (const m of bdsgMatches) {
    articles.add(`§${m[1]}-BDSG`);
  }

  // "§ 25 TTDSG"
  const ttdsgMatches = text.matchAll(/§\s*(\d+[a-z]?)\s*(?:Abs\.\s*\d+\s*)?TTDSG/gi);
  for (const m of ttdsgMatches) {
    articles.add(`§${m[1]}-TTDSG`);
  }

  return Array.from(articles).sort();
}

/** Extract fine amounts from German text */
function extractFineAmount(text: string): number | null {
  // "35.258.708 Euro", "9,55 Millionen Euro", "45 Millionen Euro"
  // "Geldbuße in Höhe von 9.550.000 Euro"
  const patterns = [
    // "X Millionen Euro" or "X,Y Millionen Euro"
    /(\d+(?:[,.]\d+)?)\s*Milli(?:on(?:en)?)\s*Euro/gi,
    // "X.XXX.XXX Euro" (German thousand separators)
    /([\d.]+)\s*Euro/gi,
    // "EUR X.XXX.XXX"
    /EUR\s*([\d.,]+)/gi,
    // "€ X.XXX.XXX"
    /€\s*([\d.,]+)/gi,
  ];

  let maxFine: number | null = null;

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const raw = m[1]!;
      let amount: number;

      if (/milli/i.test(m[0])) {
        // "9,55 Millionen" → 9550000
        const normalized = raw.replace(/\./g, "").replace(",", ".");
        amount = parseFloat(normalized) * 1_000_000;
      } else {
        // "35.258.708" → remove dots (thousand separators), use comma as decimal
        // If only one dot and digits after are < 3, treat as decimal
        const dotCount = (raw.match(/\./g) || []).length;
        if (dotCount > 1 || (dotCount === 1 && raw.split(".")[1]!.length === 3)) {
          // German thousand separator format
          const normalized = raw.replace(/\./g, "").replace(",", ".");
          amount = parseFloat(normalized);
        } else {
          // Possibly decimal dot or single thousand separator
          const normalized = raw.replace(",", ".");
          amount = parseFloat(normalized);
        }
      }

      if (!isNaN(amount) && amount > 0) {
        // Keep the largest fine mentioned (most likely the headline fine)
        if (maxFine === null || amount > maxFine) {
          maxFine = amount;
        }
      }
    }
  }

  return maxFine;
}

/** Detect decision type from text content */
function detectDecisionType(title: string, text: string): string {
  const combined = (title + " " + text).toLowerCase();
  if (combined.includes("bußgeld") || combined.includes("geldbuße")) return "bussgeld";
  if (combined.includes("anordnung")) return "anordnung";
  if (combined.includes("verwarnung")) return "verwarnung";
  if (combined.includes("untersagung")) return "untersagung";
  if (combined.includes("feststellung")) return "feststellung";
  return "entscheidung";
}

/** Map text content to topic IDs */
function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const topics: string[] = [];

  const topicKeywords: Record<string, string[]> = {
    beschaeftigtendatenschutz: ["beschäftigte", "arbeitnehmer", "personalakte", "mitarbeiter", "arbeitgeber", "bewerberdaten"],
    datenuebermittlung: ["datenübermittlung", "drittland", "drittländer", "standardvertragsklausel", "angemessenheitsbeschluss"],
    einwilligung: ["einwilligung", "consent", "opt-in", "einwilligungserklärung"],
    videoueberwachung: ["videoüberwachung", "kameraüberwachung", "videokamera", "video-überwachung"],
    gesundheitsdaten: ["gesundheitsdaten", "patientendaten", "krankheitsdat", "medizinisch"],
    datenschutz_folgenabschaetzung: ["datenschutz-folgenabschätzung", "folgenabschätzung", "dsfa", "dpia", "art. 35"],
    auftragsverarbeitung: ["auftragsverarbeitung", "auftragsverarbeiter", "art. 28", "avv"],
    cookies: ["cookie", "tracking", "ttdsg", "eprivacy", "telemedien"],
    betroffenenrechte: ["auskunftsrecht", "löschung", "berichtigung", "widerspruch", "betroffenenrecht", "art. 15", "art. 17"],
  };

  for (const [topicId, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      topics.push(topicId);
    }
  }

  return topics;
}

/** Extract entity name from a BfDI press release about a fine */
function extractEntityName(title: string, text: string): string | null {
  // "gegen XYZ" pattern — common in German enforcement press releases
  const gegenPatterns = [
    /gegen\s+(?:die\s+|den\s+|das\s+)?(.+?)\s+(?:eine?\s+Geldbuße|ein\s+Bußgeld|verhängt|wegen)/i,
    /Geldbuße[n]?\s+gegen\s+(?:die\s+|den\s+|das\s+)?(.+?)(?:\s*[.(]|\s+wegen|\s+in\s+Höhe)/i,
    /Bußgeld[bescheid]?\s+(?:—|–|-)\s+(.+?)(?:\s*[.(]|\s+wegen)/i,
  ];

  for (const pattern of gegenPatterns) {
    const match = (title + " " + text).match(pattern);
    if (match?.[1]) {
      return match[1].trim().replace(/,$/, "");
    }
  }

  return null;
}

/** Generate a reference ID from URL and date */
function generateReference(url: string, date: string | null, index: number): string {
  // Try to extract from URL path, e.g. "2019/30_BfDIverhängtGeldbuße1u1"
  const urlMatch = url.match(/\/(\d{4})\/(\d+)_/);
  if (urlMatch) {
    return `BFDI-PM-${urlMatch[1]}-${urlMatch[2]}`;
  }

  const year = date ? date.substring(0, 4) : "UNKNOWN";
  return `BFDI-${year}-${String(index).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Scraper: BfDI press release listing
// ---------------------------------------------------------------------------

async function scrapePressMitteilungenList(): Promise<ListingEntry[]> {
  console.log("\n--- Scraping BfDI press release listings ---");
  const entries: ListingEntry[] = [];

  // Strategy: crawl the paginated press release list, then filter for
  // enforcement-related entries based on title keywords.
  let page = 1;
  const maxPages = 10; // Safety limit
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const url = page === 1
      ? PM_LIST_URL
      : `${PM_LIST_URL}?gtp=292008_unnamed%253D${page}`;

    console.log(`  Fetching press release page ${page}...`);
    await sleep(REQUEST_DELAY_MS);

    try {
      const $ = await fetchHtml(url);

      // Press releases are in a table with date and title columns
      const rows = $("table tbody tr, table tr").toArray();
      let foundOnPage = 0;

      for (const row of rows) {
        const cells = $(row).find("td");
        if (cells.length < 2) continue;

        const dateCell = $(cells[0]).text().trim();
        const titleCell = cells[1] ?? cells[0];
        const link = $(titleCell).find("a");

        if (link.length === 0) continue;

        const title = link.text().trim();
        const href = link.attr("href");
        if (!href || !title) continue;

        const fullUrl = resolveUrl(BFDI_BASE, href);
        const parsedDate = parseDate(dateCell);

        entries.push({
          title,
          url: fullUrl,
          date: parsedDate,
        });
        foundOnPage++;
      }

      console.log(`  Page ${page}: found ${foundOnPage} entries`);

      // Check for next page link
      const nextLink = $("a").filter(function () {
        const text = $(this).text().trim();
        return text === "weiter" || text === `${page + 1}`;
      });
      hasMore = nextLink.length > 0 && foundOnPage > 0;
      page++;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  Error on page ${page}: ${message}`);
      hasMore = false;
    }
  }

  console.log(`  Total press release entries found: ${entries.length}`);

  // Filter to enforcement-related press releases
  const enforcementEntries = entries.filter((entry) => {
    const lower = entry.title.toLowerCase();
    return ENFORCEMENT_SEARCH_TERMS.some((term) => lower.includes(term.toLowerCase()));
  });

  console.log(`  Enforcement-related entries: ${enforcementEntries.length}`);
  return enforcementEntries;
}

// ---------------------------------------------------------------------------
// Scraper: BfDI expert search for enforcement actions
// ---------------------------------------------------------------------------

async function scrapeEnforcementSearch(): Promise<ListingEntry[]> {
  console.log("\n--- Scraping BfDI enforcement search results ---");
  const entries: ListingEntry[] = [];
  const seenUrls = new Set<string>();

  for (const term of ["Geldbuße verhängt", "Bußgeld verhängt", "Anordnung Datenschutz"]) {
    console.log(`  Searching: "${term}"...`);
    await sleep(REQUEST_DELAY_MS);

    const searchUrl = `${PM_SEARCH_URL}?templateQueryString=${encodeURIComponent(term)}&cl2Categories_Typ=pressemitteilungen&sortOrder=dateOfIssue_dt+desc`;

    try {
      const $ = await fetchHtml(searchUrl);

      // Search results are in a list-style layout
      // Each result has a title link, date, type badge, and snippet
      $("a").each(function () {
        const href = $(this).attr("href");
        const title = $(this).text().trim();

        if (!href || !title || title.length < 10) return;
        if (!href.includes("SharedDocs") && !href.includes("Pressemitteilungen")) return;
        if (title === "Mehr erfahren") return;

        const fullUrl = resolveUrl(BFDI_BASE, href);
        if (seenUrls.has(fullUrl)) return;
        seenUrls.add(fullUrl);

        // Try to find the date near this element
        const parent = $(this).parent();
        const siblingText = parent.text();
        const dateMatch = siblingText.match(/(\d{2}\.\d{2}\.\d{4})/);

        entries.push({
          title,
          url: fullUrl,
          date: dateMatch ? parseDate(dateMatch[1]!) : null,
        });
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  Search error for "${term}": ${message}`);
    }
  }

  console.log(`  Total enforcement search results: ${entries.length}`);
  return entries;
}

// ---------------------------------------------------------------------------
// Scraper: Individual press release detail page
// ---------------------------------------------------------------------------

async function scrapeDecisionDetail(entry: ListingEntry, index: number): Promise<ScrapedDecision | null> {
  try {
    await sleep(REQUEST_DELAY_MS);
    const $ = await fetchHtml(entry.url);

    // Extract the main content area
    // BfDI pages use semantic HTML — look for the main content block
    const contentSelectors = [
      "article",
      ".richtext",
      ".content",
      "#content",
      "main .text",
      "main",
      "#main",
      ".main-content",
    ];

    let bodyText = "";
    for (const selector of contentSelectors) {
      const el = $(selector);
      if (el.length > 0 && el.text().trim().length > 100) {
        bodyText = el.text().trim();
        break;
      }
    }

    // Fallback: grab all paragraph text from body
    if (bodyText.length < 100) {
      bodyText = $("p")
        .map(function () { return $(this).text().trim(); })
        .get()
        .filter((t) => t.length > 20)
        .join("\n\n");
    }

    if (bodyText.length < 50) {
      console.warn(`  Skipping ${entry.url} — insufficient content`);
      return null;
    }

    // Extract title — prefer page heading over listing title
    const pageTitle = $("h1").first().text().trim()
      || $("h2").first().text().trim()
      || entry.title;

    // Extract date from page metadata or content
    let date = entry.date;
    if (!date) {
      // Look for date in metadata
      const metaDate = $('meta[name="date"]').attr("content")
        || $('meta[property="article:published_time"]').attr("content");
      if (metaDate) {
        date = parseDate(metaDate);
      }
    }
    if (!date) {
      // Look for date patterns in content header
      const dateMatch = bodyText.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
      if (dateMatch) {
        date = parseDate(dateMatch[1]!);
      }
    }

    // Clean body text: remove excessive whitespace, nav remnants
    const cleanText = bodyText
      .replace(/\s{3,}/g, "\n\n")
      .replace(/^(Startseite|Navigation|Hauptmenü|Suche).*$/gm, "")
      .trim();

    // Build summary from first paragraph
    const paragraphs = cleanText.split(/\n{2,}/).filter((p) => p.length > 30);
    const summary = paragraphs[0]?.substring(0, 500) ?? null;

    const reference = generateReference(entry.url, date, index);
    const entityName = extractEntityName(pageTitle, cleanText);
    const fineAmount = extractFineAmount(cleanText);
    const type = detectDecisionType(pageTitle, cleanText);
    const topics = detectTopics(cleanText);
    const gdprArticles = extractGdprArticles(cleanText);

    return {
      reference,
      title: pageTitle,
      date,
      type,
      entity_name: entityName,
      fine_amount: fineAmount,
      summary,
      full_text: cleanText,
      topics: JSON.stringify(topics),
      gdpr_articles: JSON.stringify(gdprArticles),
      status: "final",
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Error scraping ${entry.url}: ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scraper: DSK Orientierungshilfen (BfDI table + DSK website)
// ---------------------------------------------------------------------------

async function scrapeOrientierungshilfen(): Promise<ListingEntry[]> {
  console.log("\n--- Scraping DSK Orientierungshilfen ---");
  const entries: ListingEntry[] = [];
  const seenUrls = new Set<string>();

  // Source 1: BfDI table page
  console.log("  Fetching BfDI Orientierungshilfen table...");
  await sleep(REQUEST_DELAY_MS);

  try {
    const $ = await fetchHtml(OH_TABLE_URL);

    $("table tbody tr, table tr").each(function () {
      const cells = $(this).find("td");
      if (cells.length < 2) return;

      const dateText = $(cells[0]).text().trim();
      const titleCell = cells[1] ?? cells[0];
      const link = $(titleCell).find("a");

      if (link.length === 0) return;

      const title = link.text().trim();
      const href = link.attr("href");
      if (!href || !title) return;

      const fullUrl = resolveUrl(BFDI_BASE, href);
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      entries.push({
        title,
        url: fullUrl,
        date: parseDate(dateText),
        type: "orientierungshilfe",
      });
    });

    console.log(`  BfDI table: ${entries.length} Orientierungshilfen`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Error scraping BfDI OH table: ${message}`);
  }

  // Source 2: DSK website
  console.log("  Fetching DSK Orientierungshilfen...");
  await sleep(REQUEST_DELAY_MS);

  try {
    const $ = await fetchHtml(DSK_OH_URL);

    $("a").each(function () {
      const href = $(this).attr("href");
      const title = $(this).text().trim();

      if (!href || !title || title.length < 10) return;
      if (!href.includes("media/oh/") && !href.includes("Orientierungshilfe")) return;

      const fullUrl = resolveUrl(DSK_BASE, href);
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      // Try to extract date from surrounding text
      const parent = $(this).parent();
      const parentText = parent.text();
      const dateMatch = parentText.match(/(\d{2}\.\d{2}\.\d{4})/);
      // Also try month-year from context
      const monthYearMatch = parentText.match(/((?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4})/i);

      entries.push({
        title: title.replace(/\s*\(PDF[^)]*\)/gi, "").trim(),
        url: fullUrl,
        date: dateMatch ? parseDate(dateMatch[1]!) : monthYearMatch ? parseDate(monthYearMatch[1]!) : null,
        type: "orientierungshilfe",
      });
    });

    console.log(`  Combined Orientierungshilfen: ${entries.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Error scraping DSK OH: ${message}`);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Scraper: DSK Kurzpapiere
// ---------------------------------------------------------------------------

async function scrapeKurzpapiere(): Promise<ListingEntry[]> {
  console.log("\n--- Scraping DSK Kurzpapiere ---");
  const entries: ListingEntry[] = [];

  await sleep(REQUEST_DELAY_MS);

  try {
    const $ = await fetchHtml(KP_LIST_URL);

    $("li a").each(function () {
      const href = $(this).attr("href");
      const title = $(this).text().trim();

      if (!href || !title || title.length < 10) return;
      if (!href.includes("kp/") && !href.includes("kurzpapier")) return;

      const fullUrl = resolveUrl(DSK_BASE, href);

      // Extract Kurzpapier number from title
      const numMatch = title.match(/Nr\.?\s*(\d+)/i);
      const kpNum = numMatch ? numMatch[1] : null;

      entries.push({
        title: `Kurzpapier${kpNum ? ` Nr. ${kpNum}` : ""} — ${title.replace(/^Kurzpapier\s*Nr\.?\s*\d+\s*[-–—]?\s*/i, "")}`,
        url: fullUrl,
        date: null, // DSK does not provide dates on the Kurzpapiere listing
        type: "kurzpapier",
      });
    });

    console.log(`  Found ${entries.length} Kurzpapiere`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Error scraping Kurzpapiere: ${message}`);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Scraper: DSK Beschlüsse (resolutions)
// ---------------------------------------------------------------------------

async function scrapeBeschluesse(): Promise<ListingEntry[]> {
  console.log("\n--- Scraping DSK Beschlüsse ---");
  const entries: ListingEntry[] = [];

  await sleep(REQUEST_DELAY_MS);

  try {
    const $ = await fetchHtml(DSK_BESCHLUESSE_URL);

    $("li a").each(function () {
      const href = $(this).attr("href");
      const title = $(this).text().trim();

      if (!href || !title || title.length < 10) return;
      if (!href.includes("media/") && !href.includes("dskb/")) return;

      const fullUrl = resolveUrl(DSK_BASE, href);

      // Try to extract date from sibling/parent text
      const parent = $(this).parent();
      const parentText = parent.text();
      const dateMatch = parentText.match(/(\d{2}\.\d{2}\.\d{4})/);

      entries.push({
        title,
        url: fullUrl,
        date: dateMatch ? parseDate(dateMatch[1]!) : null,
        type: "beschluss",
      });
    });

    console.log(`  Found ${entries.length} Beschlüsse`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Error scraping Beschlüsse: ${message}`);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Scraper: Guideline detail pages (HTML — not PDFs)
// ---------------------------------------------------------------------------

async function scrapeGuidelineDetail(entry: ListingEntry): Promise<ScrapedGuideline | null> {
  // If the URL points to a PDF, store metadata but not full text
  if (entry.url.endsWith(".pdf")) {
    const pdfInfo = await fetchPdfInfo(entry.url);
    if (!pdfInfo.available) {
      console.warn(`  PDF not available: ${entry.url}`);
      return null;
    }

    // For PDFs, we store the title and URL as the full_text content
    // since we cannot parse PDFs without heavy dependencies.
    const topics = detectTopics(entry.title);
    const refSlug = entry.title
      .replace(/[^a-zA-Z0-9äöüÄÖÜß]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 60);

    return {
      reference: `DSK-${entry.type?.toUpperCase() ?? "DOC"}-${refSlug}`,
      title: entry.title,
      date: entry.date,
      type: entry.type ?? "orientierungshilfe",
      summary: `${entry.title}. Dokument verfügbar als PDF: ${entry.url}`,
      full_text: `${entry.title}\n\nQuelle: ${entry.url}\n\nDieses Dokument liegt als PDF vor. Für den vollständigen Text siehe die verlinkte Quelle.`,
      topics: JSON.stringify(topics),
      language: "de",
    };
  }

  // HTML page — scrape the content
  try {
    await sleep(REQUEST_DELAY_MS);
    const $ = await fetchHtml(entry.url);

    const contentSelectors = [
      "article",
      ".richtext",
      ".content",
      "#content",
      "main .text",
      "main",
      "#main",
      ".publication-text",
    ];

    let bodyText = "";
    for (const selector of contentSelectors) {
      const el = $(selector);
      if (el.length > 0 && el.text().trim().length > 100) {
        bodyText = el.text().trim();
        break;
      }
    }

    if (bodyText.length < 50) {
      bodyText = $("p")
        .map(function () { return $(this).text().trim(); })
        .get()
        .filter((t) => t.length > 20)
        .join("\n\n");
    }

    if (bodyText.length < 50) {
      console.warn(`  Skipping ${entry.url} — insufficient content`);
      return null;
    }

    const pageTitle = $("h1").first().text().trim()
      || $("h2").first().text().trim()
      || entry.title;

    const cleanText = bodyText
      .replace(/\s{3,}/g, "\n\n")
      .replace(/^(Startseite|Navigation|Hauptmenü|Suche).*$/gm, "")
      .trim();

    const paragraphs = cleanText.split(/\n{2,}/).filter((p) => p.length > 30);
    const summary = paragraphs[0]?.substring(0, 500) ?? null;

    const topics = detectTopics(cleanText);

    let date = entry.date;
    if (!date) {
      const metaDate = $('meta[name="date"]').attr("content");
      if (metaDate) date = parseDate(metaDate);
    }
    if (!date) {
      const dateMatch = cleanText.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
      if (dateMatch) date = parseDate(dateMatch[1]!);
    }

    const refSlug = pageTitle
      .replace(/[^a-zA-Z0-9äöüÄÖÜß]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 60);

    return {
      reference: `DSK-${(entry.type ?? "doc").toUpperCase()}-${refSlug}`,
      title: pageTitle,
      date,
      type: entry.type ?? "orientierungshilfe",
      summary,
      full_text: cleanText,
      topics: JSON.stringify(topics),
      language: "de",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Error scraping guideline ${entry.url}: ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Topic seeding (canonical list)
// ---------------------------------------------------------------------------

interface TopicDef {
  id: string;
  name_de: string;
  name_en: string;
  description: string;
}

const CANONICAL_TOPICS: TopicDef[] = [
  {
    id: "beschaeftigtendatenschutz",
    name_de: "Beschäftigtendatenschutz",
    name_en: "Employee data protection",
    description: "Datenschutz in der Beschäftigung — Bewerberdaten, Personalakten, Mitarbeiterüberwachung, Geodaten (§ 26 BDSG).",
  },
  {
    id: "datenuebermittlung",
    name_de: "Datenübermittlung",
    name_en: "Data transfers",
    description: "Übermittlung personenbezogener Daten an Dritte und in Drittländer (Art. 44–49 DSGVO, § 78–80 BDSG).",
  },
  {
    id: "einwilligung",
    name_de: "Einwilligung",
    name_en: "Consent",
    description: "Einwilligung als Rechtsgrundlage für die Verarbeitung personenbezogener Daten (Art. 7 DSGVO).",
  },
  {
    id: "videoueberwachung",
    name_de: "Videoüberwachung",
    name_en: "Video surveillance",
    description: "Videoüberwachung öffentlich zugänglicher Räume und in Unternehmen (§ 4 BDSG, Art. 6 DSGVO).",
  },
  {
    id: "gesundheitsdaten",
    name_de: "Gesundheitsdaten",
    name_en: "Health data",
    description: "Verarbeitung besonderer Kategorien personenbezogener Daten im Gesundheitsbereich (Art. 9 DSGVO).",
  },
  {
    id: "datenschutz_folgenabschaetzung",
    name_de: "Datenschutz-Folgenabschätzung",
    name_en: "Data Protection Impact Assessment",
    description: "Datenschutz-Folgenabschätzung (DSFA) für risikoreiche Verarbeitungen (Art. 35 DSGVO).",
  },
  {
    id: "auftragsverarbeitung",
    name_de: "Auftragsverarbeitung",
    name_en: "Data processing agreements",
    description: "Auftragsverarbeitung und Verträge mit Auftragsverarbeitern (Art. 28 DSGVO).",
  },
  {
    id: "cookies",
    name_de: "Cookies und Tracking",
    name_en: "Cookies and tracking",
    description: "Einsatz von Cookies und Tracking-Technologien im Internet (§ 25 TTDSG, Art. 6 DSGVO).",
  },
  {
    id: "betroffenenrechte",
    name_de: "Betroffenenrechte",
    name_en: "Data subject rights",
    description: "Rechte der betroffenen Personen: Auskunft, Berichtigung, Löschung, Widerspruch (Art. 12–22 DSGVO).",
  },
  {
    id: "technische_massnahmen",
    name_de: "Technische und organisatorische Maßnahmen",
    name_en: "Technical and organizational measures",
    description: "Anforderungen an TOMs zum Schutz personenbezogener Daten (Art. 32 DSGVO).",
  },
  {
    id: "datenschutzbeauftragter",
    name_de: "Datenschutzbeauftragter",
    name_en: "Data protection officer",
    description: "Benennung, Stellung und Aufgaben des Datenschutzbeauftragten (Art. 37–39 DSGVO, § 38 BDSG).",
  },
  {
    id: "telekommunikation",
    name_de: "Telekommunikation",
    name_en: "Telecommunications",
    description: "Datenschutz in der Telekommunikation (TKG, TTDSG).",
  },
  {
    id: "ki_kuenstliche_intelligenz",
    name_de: "Künstliche Intelligenz",
    name_en: "Artificial intelligence",
    description: "Datenschutzrechtliche Anforderungen beim Einsatz von KI-Systemen.",
  },
  {
    id: "biometrische_daten",
    name_de: "Biometrische Daten",
    name_en: "Biometric data",
    description: "Verarbeitung biometrischer Daten zur Identifizierung natürlicher Personen (Art. 9 DSGVO).",
  },
  {
    id: "meldepflicht",
    name_de: "Meldepflicht bei Datenpannen",
    name_en: "Data breach notification",
    description: "Meldung von Verletzungen des Schutzes personenbezogener Daten (Art. 33–34 DSGVO).",
  },
  {
    id: "informationspflichten",
    name_de: "Informationspflichten",
    name_en: "Information obligations",
    description: "Informationspflichten bei Datenerhebung (Art. 13–14 DSGVO).",
  },
  {
    id: "gemeinsam_verantwortliche",
    name_de: "Gemeinsam Verantwortliche",
    name_en: "Joint controllers",
    description: "Gemeinsame Verantwortlichkeit und Vereinbarung nach Art. 26 DSGVO.",
  },
  {
    id: "profiling",
    name_de: "Profiling und automatisierte Entscheidungen",
    name_en: "Profiling and automated decisions",
    description: "Profiling und automatisierte Einzelentscheidungen (Art. 22 DSGVO).",
  },
  {
    id: "direktwerbung",
    name_de: "Direktwerbung",
    name_en: "Direct marketing",
    description: "Datenschutzrechtliche Anforderungen an Direktwerbung und Kundenansprache.",
  },
  {
    id: "zertifizierung",
    name_de: "Zertifizierung",
    name_en: "Certification",
    description: "Datenschutzzertifizierung und genehmigte Verhaltensregeln (Art. 42–43 DSGVO).",
  },
];

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== BfDI Ingestion Crawler ===");
  console.log(`Database: ${DB_PATH}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : force ? "FORCE (recreate)" : resume ? "RESUME" : "normal"}`);

  // --- Bootstrap database ---
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH) && !dryRun) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  let db: Database.Database | null = null;
  if (!dryRun) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    console.log(`Database initialised at ${DB_PATH}`);
  }

  const progress = loadProgress();

  // --- Phase 1: Topics ---
  if (!resume || progress.phase === "init" || progress.topicsIngested === 0) {
    console.log("\n=== Phase 1: Topics ===");
    progress.phase = "topics";

    if (!dryRun && db) {
      const insertTopic = db.prepare(
        "INSERT OR IGNORE INTO topics (id, name_de, name_en, description) VALUES (?, ?, ?, ?)",
      );
      const insertAll = db.transaction(() => {
        for (const t of CANONICAL_TOPICS) {
          insertTopic.run(t.id, t.name_de, t.name_en, t.description);
        }
      });
      insertAll();
      progress.topicsIngested = CANONICAL_TOPICS.length;
    }

    console.log(`Inserted ${CANONICAL_TOPICS.length} topics`);
    saveProgress(progress);
  }

  // --- Phase 2: Decisions (enforcement actions) ---
  console.log("\n=== Phase 2: Decisions (enforcement actions) ===");
  progress.phase = "decisions";
  saveProgress(progress);

  // Gather all enforcement-related listings from multiple sources
  const [pmEntries, searchEntries] = await Promise.all([
    scrapePressMitteilungenList(),
    scrapeEnforcementSearch(),
  ]);

  // Deduplicate by URL
  const allDecisionEntries = new Map<string, ListingEntry>();
  for (const entry of [...pmEntries, ...searchEntries]) {
    if (!allDecisionEntries.has(entry.url)) {
      allDecisionEntries.set(entry.url, entry);
    }
  }

  const decisionUrls = Array.from(allDecisionEntries.values());
  console.log(`\nTotal unique decision URLs to process: ${decisionUrls.length}`);

  // Prepare DB statements
  const insertDecision = !dryRun && db
    ? db.prepare(`
        INSERT OR IGNORE INTO decisions
          (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
    : null;

  let decisionsProcessed = 0;
  let decisionsInserted = 0;

  for (const entry of decisionUrls) {
    // Skip if already processed (resume mode)
    if (resume && progress.completedUrls.includes(entry.url)) {
      decisionsProcessed++;
      continue;
    }

    console.log(`  [${decisionsProcessed + 1}/${decisionUrls.length}] ${entry.title.substring(0, 80)}...`);

    if (dryRun) {
      console.log(`    DRY RUN: would fetch ${entry.url}`);
      decisionsProcessed++;
      continue;
    }

    const decision = await scrapeDecisionDetail(entry, decisionsProcessed);
    if (decision && insertDecision) {
      try {
        insertDecision.run(
          decision.reference,
          decision.title,
          decision.date,
          decision.type,
          decision.entity_name,
          decision.fine_amount,
          decision.summary,
          decision.full_text,
          decision.topics,
          decision.gdpr_articles,
          decision.status,
        );
        decisionsInserted++;
        console.log(`    Inserted: ${decision.reference} (${decision.type}${decision.fine_amount ? `, €${decision.fine_amount.toLocaleString("de-DE")}` : ""})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // UNIQUE constraint = already exists, skip silently
        if (message.includes("UNIQUE")) {
          console.log(`    Skipped (duplicate): ${decision.reference}`);
        } else {
          console.warn(`    DB insert error: ${message}`);
        }
      }
    }

    progress.completedUrls.push(entry.url);
    decisionsProcessed++;
    progress.decisionsIngested = decisionsInserted;
    saveProgress(progress);
  }

  console.log(`\nDecisions: processed ${decisionsProcessed}, inserted ${decisionsInserted}`);

  // --- Phase 3: Guidelines ---
  console.log("\n=== Phase 3: Guidelines (Orientierungshilfen, Kurzpapiere, Beschlüsse) ===");
  progress.phase = "guidelines";
  saveProgress(progress);

  const [ohEntries, kpEntries, beschlussEntries] = await Promise.all([
    scrapeOrientierungshilfen(),
    scrapeKurzpapiere(),
    scrapeBeschluesse(),
  ]);

  // Deduplicate by URL
  const allGuidelineEntries = new Map<string, ListingEntry>();
  for (const entry of [...ohEntries, ...kpEntries, ...beschlussEntries]) {
    if (!allGuidelineEntries.has(entry.url)) {
      allGuidelineEntries.set(entry.url, entry);
    }
  }

  const guidelineUrls = Array.from(allGuidelineEntries.values());
  console.log(`\nTotal unique guideline URLs to process: ${guidelineUrls.length}`);

  const insertGuideline = !dryRun && db
    ? db.prepare(`
        INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
    : null;

  let guidelinesProcessed = 0;
  let guidelinesInserted = 0;

  for (const entry of guidelineUrls) {
    if (resume && progress.completedUrls.includes(entry.url)) {
      guidelinesProcessed++;
      continue;
    }

    console.log(`  [${guidelinesProcessed + 1}/${guidelineUrls.length}] ${entry.title.substring(0, 80)}...`);

    if (dryRun) {
      console.log(`    DRY RUN: would fetch ${entry.url}`);
      guidelinesProcessed++;
      continue;
    }

    const guideline = await scrapeGuidelineDetail(entry);
    if (guideline && insertGuideline) {
      try {
        insertGuideline.run(
          guideline.reference,
          guideline.title,
          guideline.date,
          guideline.type,
          guideline.summary,
          guideline.full_text,
          guideline.topics,
          guideline.language,
        );
        guidelinesInserted++;
        console.log(`    Inserted: ${guideline.reference ?? guideline.title.substring(0, 40)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`    DB insert error: ${message}`);
      }
    }

    progress.completedUrls.push(entry.url);
    guidelinesProcessed++;
    progress.guidelinesIngested = guidelinesInserted;
    saveProgress(progress);
  }

  console.log(`\nGuidelines: processed ${guidelinesProcessed}, inserted ${guidelinesInserted}`);

  // --- Summary ---
  if (db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
    ).cnt;
    const guidelineCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
    ).cnt;
    const topicCount = (
      db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
    ).cnt;
    const decisionFtsCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
    ).cnt;
    const guidelineFtsCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
    ).cnt;

    console.log("\n=== Database summary ===");
    console.log(`  Topics:         ${topicCount}`);
    console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
    console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);

    db.close();
  }

  // Clean up progress file on successful completion
  progress.phase = "complete";
  saveProgress(progress);

  console.log(`\nDone. Database ready at ${DB_PATH}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
