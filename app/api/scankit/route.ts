import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const token = process.env.SCANKIT_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      {
        error:
          'Missing SCANKIT_API_TOKEN. Add it to your .env.local (server-side only).',
      },
      { status: 500 },
    );
  }

  let incoming: FormData;
  try {
    incoming = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'Invalid multipart/form-data body.' },
      { status: 400 },
    );
  }

  const file = incoming.get('file');
  const returnPdf = incoming.get('return_pdf')?.toString() ?? 'true';

  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        error:
          "Expected multipart field 'file' to be a File. Use 'file' for single image or 'files' for multiple images.",
      },
      { status: 400 },
    );
  }

  const upstreamForm = new FormData();
  upstreamForm.append('file', file, file.name);
  upstreamForm.append('return_pdf', returnPdf);

  const upstreamRes = await fetch('https://api.scankit.io/scan/crop', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Do NOT set Content-Type manually for multipart; fetch will add the boundary.
    },
    body: upstreamForm,
  });

  // Pass through the upstream response (could be PDF, JSON, or text).
  const contentType = upstreamRes.headers.get('content-type') ?? '';
  const body = await upstreamRes.arrayBuffer();

  return new NextResponse(body, {
    status: upstreamRes.status,
    headers: {
      'content-type': contentType || 'application/octet-stream',
    },
  });
}
