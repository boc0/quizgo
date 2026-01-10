import { NextRequest, NextResponse } from 'next/server';
import { GoogleAuth } from 'google-auth-library';

export const runtime = 'nodejs';

function isBlobLike(
  value: unknown,
): value is { type?: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  if (typeof value !== 'object' || value === null) return false;

  // Use an indexable record to avoid `any` while still checking a dynamic prop.
  const record = value as Record<string, unknown>;
  return typeof record.arrayBuffer === 'function';
}

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

  let serviceAccountCredentials: Record<string, unknown>;
  try {
    serviceAccountCredentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: 'Invalid GOOGLE_SERVICE_ACCOUNT_JSON (expected valid JSON string).' },
      { status: 500 },
    );
  }

  const clientEmail = serviceAccountCredentials.client_email;
  const privateKey = serviceAccountCredentials.private_key;
  const tokenUri = serviceAccountCredentials.token_uri;
  if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
    return NextResponse.json(
      {
        error:
          'GOOGLE_SERVICE_ACCOUNT_JSON is missing required fields (expected client_email and private_key).',
      },
      { status: 500 },
    );
  }
  if (tokenUri != null && typeof tokenUri !== 'string') {
    return NextResponse.json(
      {
        error:
          'GOOGLE_SERVICE_ACCOUNT_JSON has invalid token_uri (expected string).',
      },
      { status: 500 },
    );
  }

  // Normalize the key in case the env var ended up double-escaped.
  const normalizedCredentials = {
    ...serviceAccountCredentials,
    private_key: privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey,
  } as Record<string, unknown>;

  let accessToken: string | undefined;
  try {
    const auth = new GoogleAuth({
      credentials: normalizedCredentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const accessTokenResp = await client.getAccessToken();
    accessToken =
      typeof accessTokenResp === 'string' ? accessTokenResp : accessTokenResp?.token ?? undefined;
  } catch (err) {
    console.error('Failed to obtain Google access token:', err);
    return NextResponse.json(
      {
        error: 'Failed to obtain Google access token.',
        ...(process.env.NODE_ENV !== 'production'
          ? {
            details:
              err instanceof Error
                ? err.message
                : typeof err === 'string'
                  ? err
                  : JSON.stringify(err),
            hint:
              'If you see PEM/crypto errors, your private_key is malformed (often due to newline escaping).',
          }
          : {}),
      },
      { status: 500 },
    );
  }

  if (!accessToken) {
    return NextResponse.json(
      { error: 'Failed to obtain Google access token.' },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    console.error('Failed to parse formData():', err);
    return NextResponse.json(
      { error: 'Invalid multipart/form-data body.' },
      { status: 400 },
    );
  }

  const file = form.get('file');

  // Avoid `instanceof File` in Node runtime.
  if (!isBlobLike(file)) {
    return NextResponse.json(
      { error: "Expected multipart field 'file' to be a file/blob." },
      { status: 400 },
    );
  }

  const mimeType = typeof file.type === 'string' && file.type ? file.type : 'application/pdf';
  if (mimeType !== 'application/pdf') {
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

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Fetch to Document AI failed:', err);
    return NextResponse.json(
      { error: 'Failed to call Document AI endpoint.' },
      { status: 500 },
    );
  }

  const contentType = upstreamRes.headers.get('content-type') ?? '';

  let data: unknown;
  try {
    data = await upstreamRes.json();
  } catch {
    const text = await upstreamRes.text().catch(() => '');
    data = { error: 'Non-JSON response from Document AI', body: text };
  }

  console.log('Document AI response:', {
    status: upstreamRes.status,
    contentType,
    body: data,
  });

  return NextResponse.json(data, { status: upstreamRes.status });
}