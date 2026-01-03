import { NextRequest, NextResponse } from 'next/server';
import { GoogleAuth } from 'google-auth-library';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const LOCATION = process.env.LOCATION;
  const PROJECT_ID = process.env.PROJECT_ID;
  const PROCESSOR_ID = process.env.PROCESSOR_ID;
  const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!LOCATION || !PROJECT_ID || !PROCESSOR_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
    return NextResponse.json(
      {
        error:
          'Missing one or more required env vars: LOCATION, PROJECT_ID, PROCESSOR_ID, GOOGLE_SERVICE_ACCOUNT_JSON',
      },
      { status: 500 },
    );
  }

  let serviceAccountCredentials: unknown;
  try {
    serviceAccountCredentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    return NextResponse.json(
      {
        error:
          'Invalid GOOGLE_SERVICE_ACCOUNT_JSON (expected valid JSON string).',
      },
      { status: 500 },
    );
  }

  const auth = new GoogleAuth({
    credentials: serviceAccountCredentials as Record<string, unknown>,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();
  const accessTokenResp = await client.getAccessToken();
  const accessToken =
    typeof accessTokenResp === 'string'
      ? accessTokenResp
      : accessTokenResp?.token;

  if (!accessToken) {
    return NextResponse.json(
      { error: 'Failed to obtain Google access token.' },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'Invalid multipart/form-data body.' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Expected multipart field 'file' to be a PDF File." },
      { status: 400 },
    );
  }

  const mimeType = file.type || 'application/pdf';
  if (mimeType !== 'application/pdf') {
    // Not strictly required, but keeps behavior predictable.
    return NextResponse.json(
      { error: `Expected application/pdf, got ${mimeType}` },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const base64 = bytes.toString('base64');

  const url = `https://${LOCATION}-documentai.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}:process`;

  const payload = {
    skipHumanReview: true,
    rawDocument: {
      mimeType: 'application/pdf',
      content: base64,
    },
  };

  const upstreamRes = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const contentType = upstreamRes.headers.get('content-type') ?? '';

  // Try to parse JSON (Document AI responds JSON even on errors).
  let data: unknown;
  try {
    data = await upstreamRes.json();
  } catch {
    const text = await upstreamRes.text().catch(() => '');
    data = { error: 'Non-JSON response from Document AI', body: text };
  }

  // Print to server console as requested.
  console.log('Document AI response:', {
    status: upstreamRes.status,
    contentType,
    body: data,
  });

  return NextResponse.json(data, { status: upstreamRes.status });
}
