import { query, getStorageReader } from "../../../../lib/db";

// Storage bucket `raw` (M0-S1) is private. The Sources page links here
// instead of at Storage directly; this route looks up the manifest row's
// storage_key by its api.sources id, mints a short-lived signed URL
// server-side with the publishable key under a SELECT-only bucket policy
// (migration 0211), and 302-redirects to it.

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const rows = await query<{ storage_key: string }>(
    "select storage_key from api.sources where source_id = $1 limit 1",
    [id]
  );

  if (rows.length === 0) {
    return new Response("Source not found", { status: 404 });
  }

  const { storage_key } = rows[0];

  const { data, error } = await getStorageReader()
    .storage.from("raw")
    .createSignedUrl(storage_key, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    return new Response("Failed to create a signed URL for the raw file", {
      status: 502,
    });
  }

  return Response.redirect(data.signedUrl, 302);
}
