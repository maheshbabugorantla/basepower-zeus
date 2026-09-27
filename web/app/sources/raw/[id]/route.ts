import { query, getStorageReader } from "../../../../lib/db";

// Storage bucket `raw` (M0-S1) is private. The Sources page links here
// instead of at Storage directly; this route looks up the manifest row's
// storage_key by its api.sources id, mints a short-lived signed URL
// server-side with the publishable key under a SELECT-only bucket policy
// (migration 0211), and 302-redirects to it.

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 60;

function unavailablePage(opts: { title: string; body: string; publisherUrl?: string; publisherLabel?: string }): Response {
  // T6 fix: a bare "Failed to create a signed URL" (or a bare 404) left
  // a rep or reviewer stuck with no path forward. This is still an
  // honest failure state (never a fabricated download), but it now
  // names the dataset and, when we have one, links straight to the
  // publisher's own page so the person can get the file another way.
  const link = opts.publisherUrl
    ? `<p><a href="${opts.publisherUrl}" target="_blank" rel="noreferrer noopener">${opts.publisherLabel ?? "See the publisher's own page"}</a></p>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${opts.title}</title></head>
<body style="font-family: sans-serif; max-width: 60ch; margin: 3rem auto; color: #292826;">
<h1>${opts.title}</h1>
<p>${opts.body}</p>
${link}
</body></html>`;
  return new Response(html, { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const rows = await query<{ storage_key: string; source: string; url: string }>(
    "select storage_key, source, url from api.sources where source_id = $1 limit 1",
    [id]
  );

  if (rows.length === 0) {
    return new Response("Source not found", { status: 404 });
  }

  const { storage_key, source, url } = rows[0];

  const { data, error } = await getStorageReader()
    .storage.from("raw")
    .createSignedUrl(storage_key, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error(`sources/raw/${id}: failed to sign storage_key=${storage_key} for source=${source}`, error);
    return unavailablePage({
      title: "This raw file isn't downloadable right now",
      body:
        `The "${source}" file this number traces to couldn't be retrieved from storage just now. ` +
        `Its checksum and retrieval time are still shown on the Sources page -- only the download link failed.`,
      publisherUrl: url,
      publisherLabel: "See the publisher's own page for this dataset",
    });
  }

  return Response.redirect(data.signedUrl, 302);
}
