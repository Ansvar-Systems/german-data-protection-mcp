# Tools Reference

All tools exposed by the German Data Protection MCP server. Tool prefix: `de_dp_`.

## Tool List (8)

| Tool | Purpose |
|------|---------|
| [`de_dp_search_decisions`](#de_dp_search_decisions) | Full-text search across BfDI decisions |
| [`de_dp_get_decision`](#de_dp_get_decision) | Fetch a specific decision by reference |
| [`de_dp_search_guidelines`](#de_dp_search_guidelines) | Full-text search across BfDI/DSK guidance |
| [`de_dp_get_guideline`](#de_dp_get_guideline) | Fetch a specific guideline by ID |
| [`de_dp_list_topics`](#de_dp_list_topics) | List all data protection topics |
| [`de_dp_about`](#de_dp_about) | Server metadata and coverage counts |
| [`de_dp_list_sources`](#de_dp_list_sources) | List all data sources with provenance |
| [`de_dp_check_data_freshness`](#de_dp_check_data_freshness) | Check corpus freshness and record counts |

---

## de_dp_search_decisions

Full-text search across BfDI decisions (Bußgeldbescheide, Verfahren, Anordnungen).

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query in German (e.g., `"Einwilligung Cookies"`, `"H&M"`) |
| `type` | string | no | Filter by type: `bussgeld`, `anordnung`, `verfahren`, `bescheid` |
| `topic` | string | no | Filter by topic ID (e.g., `"einwilligung"`, `"videoüberwachung"`) |
| `limit` | number | no | Maximum results (1–100, default 20) |

**Response fields:** `results[]`, `count`, `_meta`

Each result includes `_citation` with `canonical_ref`, `display_text`, and `lookup`.

---

## de_dp_get_decision

Fetch a specific BfDI decision by reference number.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | yes | BfDI decision reference number (e.g., `"BFDI-2022-001"`) |

**Response fields:** Full decision record + `_citation` + `_meta`

**Error types:** `not_found`

---

## de_dp_search_guidelines

Search BfDI and DSK guidance documents: Orientierungshilfen, Kurzpapiere, Hinweise, Empfehlungen.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query in German (e.g., `"Datenschutz-Folgenabschätzung"`) |
| `type` | string | no | Filter by type: `orientierungshilfe`, `kurzpapier`, `hinweis`, `empfehlung` |
| `topic` | string | no | Filter by topic ID |
| `limit` | number | no | Maximum results (1–100, default 20) |

**Response fields:** `results[]`, `count`, `_meta`

Each result includes `_citation` with `canonical_ref`, `display_text`, and `lookup`.

---

## de_dp_get_guideline

Fetch a specific BfDI/DSK guidance document by its database ID.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | yes | Guideline database ID (from search results) |

**Response fields:** Full guideline record + `_citation` + `_meta`

**Error types:** `not_found`

---

## de_dp_list_topics

List all covered data protection topics with German and English names. Use topic IDs to filter decisions and guidelines.

**Input:** none

**Response fields:** `topics[]`, `count`, `_meta`

Each topic has `id`, `name_de`, `name_en`, `description`.

---

## de_dp_about

Return metadata about this MCP server: version, data source, coverage counts, and tool list.

**Input:** none

**Response fields:** `name`, `version`, `description`, `data_source`, `coverage`, `tools[]`, `_meta`

---

## de_dp_list_sources

List all data sources used by this MCP server with publisher, URL, coverage scope, and license.

**Input:** none

**Response fields:** `sources[]`, `count`, `last_ingested`, `_meta`

Each source has `id`, `name`, `url`, `type`, `coverage`, `language`, `license`.

---

## de_dp_check_data_freshness

Check when the corpus was last ingested, how many records exist, and whether the data may be stale.

**Input:** none

**Response fields:** `status` (`fresh` | `stale`), `last_ingested`, `last_data_date`, `age_days`, `record_counts`, `freshness_note`, `sources[]`, `_meta`

Data is considered stale if `age_days > 30`.

---

## Common Response Fields

### `_meta`

Present on all successful responses:

```json
{
  "disclaimer": "Not legal advice. ...",
  "data_age": "YYYY-MM-DD",
  "copyright": "BfDI / DSK — official German federal publications (public domain)",
  "source_url": "https://www.bfdi.bund.de/"
}
```

### `_citation`

Present on `get_*` responses and per-item in `search_*` results:

```json
{
  "canonical_ref": "BFDI-2022-001",
  "display_text": "BfDI Decision BFDI-2022-001",
  "source_url": "https://...",
  "lookup": {
    "tool": "de_dp_get_decision",
    "args": { "reference": "BFDI-2022-001" }
  }
}
```

### Error responses

All errors return `isError: true` and structured JSON content:

```json
{
  "error": "Human-readable message",
  "_error_type": "not_found | validation_error | unknown_tool | execution_error"
}
```
