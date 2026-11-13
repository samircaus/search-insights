# Demo script (≈ 2½ minutes)

**Setup:**
- Have an edgepatterns.dev article with real search traffic open in Experience Workspace, e.g. `/martech/fpid`.
- Google is already connected.
- Keep a second tab with `https://search.edgepatterns.dev/?demo` as a fallback. It is labelled "Demo data" and cannot open Workspace Chat.

---

**0:00 – The problem (15 s)**
> "Authors edit pages here, but the evidence about how people find those pages lives in Search Console and Bing Webmaster Tools. Those are site-wide dashboards the author has to filter by hand. Search Insights brings that evidence to the page being edited."

**0:15 – Open it (20 s)**
- Open the side-panel switcher and choose **Search Insights**.
- Point at the page identity: the document path, the **public URL** it resolved to, and "canonical URL matches".
> "It maps the Workspace document to the URL search engines actually report, using the site's production domain. It isn't the editor or preview URL. If the mapping is ambiguous, I can override it, but only to URLs on this site."
- Point at the **Live data** status, then **Index status**: indexed and last crawl. Open **Index details** for Google's chosen canonical, sitemap and Search Console link.
> "First question: is Google even indexing this page, and under which URL? If it chose a different canonical, the panel offers to switch to that URL, because that's where the data lives." 

**0:35 – What brings people here (35 s)**
- Google tab: the period with real dates, and "finalized data through …".
> "Last 28 finalized days versus the 28 before. Clicks, impressions, CTR (with the change in percentage points) and average position, where lower is better."
- Scroll to the query table. Sort by impressions, then filter to **Position 8–20**. Use **Show more** if there are more than 10 matching rows.
> "These are the queries this page actually appears for. Google only returns top rows, and the panel says what share of clicks they cover."

**1:10 – What changed and what to review (35 s)**
- Expand one **Review** card, e.g. low click-through, then **What to check**.
> "Each card says exactly why it was flagged, with the numbers and dates. It suggests checks, not conclusions. A low CTR isn't automatically a title problem, and low-volume pages get no recommendations at all."
- Tick the card and two queries.

**1:45 – Ask in Chat (30 s)**
- Click **Ask in Chat** and review the prompt in Workspace AI.
> "The prompt includes the page, dates, selected evidence, suggested checks and caveats. The author reviews and sends it. Search Insights does not send it or edit the document."
- If Chat does not open, treat the handoff as unverified. Demo mode cannot open Chat.

**2:15 – Bing (optional, 15 s)**
- If Bing is configured or you are using demo data, switch to the **Bing** tab. Otherwise the tab is hidden, so skip this part.
> "Same conventions, kept separate. Bing reports weekly rows without date ranges, so the period follows Bing's own dates, and comparisons only appear when they're actually comparable. These are search statistics, not Copilot citations."

**2:30 – Close (10 s)**
> "It's one deployable Worker plus one library-sheet row, configured per site. The repository README walks another team through it with their own credentials."
