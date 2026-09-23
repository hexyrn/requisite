import React, { useEffect, useState } from 'react';
import { Card, Button } from '@hexyrn/design-system';
import { supportBundleApi } from '../api/admin';

/** P3 item 21/8: support bundle preview + generate. Never uploaded automatically - only returned to the requesting admin. */
export function AdminSupportBundlePage() {
  const [categories, setCategories] = useState<string[] | null>(null);
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    supportBundleApi
      .previewCategories()
      .then((res) => setCategories(res.categories))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load support bundle categories.'));
  }, []);

  async function onGenerate() {
    setGenerating(true);
    setError(null);
    setBundle(null);
    try {
      setBundle(await supportBundleApi.generate());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generating the support bundle failed.');
    } finally {
      setGenerating(false);
    }
  }

  function onDownload() {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hexyrn-support-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {error && <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>{error}</div>}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>What's included</h2>
        {categories === null ? (
          <p>Loading…</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {categories.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
        <p style={{ color: '#616e7c', marginTop: 8 }}>
          Secrets and credentials are redacted before the bundle is generated. Nothing is uploaded automatically - the
          bundle is only ever returned directly to you to download and share as you choose.
        </p>
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Generate support bundle</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={onGenerate} disabled={generating}>
            {generating ? 'Generating…' : 'Generate Support Bundle'}
          </Button>
          {bundle && (
            <Button variant="secondary" onClick={onDownload}>
              Download
            </Button>
          )}
        </div>
        {bundle && (
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f5f6f8', padding: 12, borderRadius: 6, marginTop: 12, maxHeight: 400, overflow: 'auto' }}>
            {JSON.stringify(bundle, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  );
}
