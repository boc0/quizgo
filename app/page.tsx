'use client';

import { useMemo, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export default function Home() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState<'submit' | 'manage'>('manage');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const tab = searchParams.get('tab');
    const nextTab: 'submit' | 'manage' = tab === 'submit' ? 'submit' : 'manage';
    setActiveTab(nextTab);
  }, [searchParams]);

  const setTab = (tab: 'submit' | 'manage') => {
    setActiveTab(tab);

    const params = new URLSearchParams(searchParams.toString());
    // Make Manage the default (no query param). When switching to Submit,
    // set `?tab=submit`; when switching to Manage, remove the param.
    if (tab === 'submit') {
      params.set('tab', 'submit');
    } else {
      params.delete('tab');
    }

    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const selectedLabel = useMemo(() => {
    if (!selectedFile) return 'No file selected';
    return `${selectedFile.name} (${Math.round(selectedFile.size / 1024)} KB)`;
  }, [selectedFile]);

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });

  const loadImageFromFile = async (file: File): Promise<HTMLImageElement> => {
    const dataUrl = await readFileAsDataUrl(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image.'));
      img.src = dataUrl;
    });
  };

  const resizeHalf = async (file: File): Promise<File> => {
    // Assumption per your note: input image is always 3024 x 4032.
    // We always output half: 1512 x 2016.
    const targetWidth = 1512;
    const targetHeight = 2016;

    const img = await loadImageFromFile(file);
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available.');

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const mimeType = file.type?.startsWith('image/') ? file.type : 'image/jpeg';
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to encode resized image.'))),
        mimeType,
        mimeType === 'image/jpeg' ? 0.9 : undefined,
      );
    });

    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const outName = `${baseName}-half.${ext}`;
    return new File([blob], outName, { type: mimeType });
  };

  const submitToScanKit = async () => {
    if (!selectedFile) return;

    setIsSubmitting(true);
    try {
      const resizedFile = await resizeHalf(selectedFile);
      console.log(
        'Resized image:',
        {
          original: {
            name: selectedFile.name,
            bytes: selectedFile.size,
            type: selectedFile.type,
          },
          resized: {
            name: resizedFile.name,
            bytes: resizedFile.size,
            type: resizedFile.type,
          },
        },
      );

      // ScanKit expects multipart/form-data with a real file field named `file`.
      const form = new FormData();
      form.append('file', resizedFile);
      form.append('return_pdf', 'true');

      console.log('Sending file to ScanKit:', resizedFile.name);

      const res = await fetch('/api/scankit', {
        method: 'POST',
        body: form,
      });

      const contentType = res.headers.get('content-type') ?? '';
      console.log('ScanKit response status:', res.status);
      console.log('ScanKit response content-type:', contentType);

      if (contentType.includes('application/pdf')) {
        const buffer = await res.arrayBuffer();
        console.log('ScanKit PDF bytes:', buffer.byteLength);

        const pdfBlob = new Blob([buffer], { type: 'application/pdf' });
        const url = URL.createObjectURL(pdfBlob);

        window.open(url, '_blank');

        // Also trigger an automatic download to the user's machine:
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scankit-result.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();

        console.log('ScanKit PDF blob URL:', url);

        // Send PDF to Document AI (server-side token/env vars).
        const docForm = new FormData();
        docForm.append(
          'file',
          new File([pdfBlob], 'scankit-result.pdf', { type: 'application/pdf' }),
        );

        const docRes = await fetch('/api/documentai', {
          method: 'POST',
          body: docForm,
        });

        console.log('Document AI response status:', docRes.status);
        console.log('Document AI response body:', await docRes.json());
      } else if (contentType.includes('application/json')) {
        console.log('ScanKit response body:', await res.json());
      } else {
        console.log('ScanKit response body:', await res.text());
      }
    } catch (error) {
      console.error('ScanKit request failed:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-end gap-1 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setTab('manage')}
            className={
              activeTab === 'manage'
                ? 'relative -mb-px rounded-t-md border border-b-white border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900'
                : 'rounded-t-md border border-transparent px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900'
            }
          >
            Manage
          </button>
          <button
            type="button"
            onClick={() => setTab('submit')}
            className={
              activeTab === 'submit'
                ? 'relative -mb-px rounded-t-md border border-b-white border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900'
                : 'rounded-t-md border border-transparent px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900'
            }
          >
            Submit
          </button>
        </div>

        <div className="rounded-b-lg border border-t-0 border-gray-200 bg-white p-6">
          {activeTab === 'submit' ? (
            <>
              <h1 className="text-xl font-semibold">ScanKit Crop API</h1>
              <p className="mt-1 text-sm text-gray-600">
                Upload an image of a quiz response sheet, unskew it, then read the answers.
              </p>

              <div className="mt-6 space-y-3">
                <label className="block text-sm font-medium text-gray-700">
                  Image
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-gray-200"
                />
                <div className="text-xs text-gray-500">{selectedLabel}</div>

                <button
                  type="button"
                  disabled={!selectedFile || isSubmitting}
                  onClick={submitToScanKit}
                  className="mt-2 inline-flex w-full items-center justify-center rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? 'Sending…' : 'Send to ScanKit'}
                </button>
              </div>
            </>
          ) : (
            <></>
          )}
        </div>
      </div>
    </div>
  );
}
