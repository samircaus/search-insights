# Suggested listing text

> **Status:** I could not find official submission guidance for an Experience Workspace extension marketplace (searched 2026-11-09). Do not treat this project as submission-ready until the organisers' requirements are confirmed. The text below is a suggestion only. No listing metadata format is assumed.

## Name
Search Insights

## One-line description
Google Search Console and Bing Webmaster Tools evidence for the page you are editing, with a copyable editing brief.

## Description
Search Insights answers a content author's question without leaving Experience Workspace: *what brings people to this page, what has changed, and what should I review?*

Open it from the library while editing a page. It:
- resolves the page's public URL
- shows clicks, impressions, CTR and average position from Google Search Console and Bing Webmaster Tools, kept on separate tabs
- compares the latest finalized period with the previous one where the provider supports it
- lists the queries people used to find the page

Transparent rules then flag items worth reviewing: declining clicks, low click-through at good positions, queries near the first-page boundary, and queries appearing in this period's data. Each item shows its evidence, dates and cautious checks. Select evidence to generate an editing brief, preview it, and copy it as Markdown or plain text. You can optionally insert it into the document after confirming.

Read-only by design: it never edits, saves or publishes content automatically.

## Feature summary
- Page-level search data for the document being edited, mapped to its public production URL (with canonical check and constrained override)
- Google Search Console (read-only OAuth, finalized data, Domain and URL-prefix properties)
- Index status per page from Google URL Inspection: indexed or not and why, last crawl, Google versus declared canonical, rich-result errors
- Bing Webmaster Tools (OAuth or deployment API key, weekly data shown honestly)
- Clear dates, freshness, units and change directions; CTR changes in percentage points
- Deterministic opportunity cards with evidence and caveats; low-volume pages suppressed
- Editing brief in Markdown or plain text; optional explicit insertion
- Server-side token storage (encrypted), Adobe IMS + DA site authorization, per-site configuration
- Demo mode with labelled fixture data

## Requirements
- An Edge Delivery Services site authored in Experience Workspace
- A Search Console property and/or a verified Bing Webmaster Tools site
- A Cloudflare account to host the Worker (see README)
