import { useEffect, useRef, useState } from 'react';

function PdfPage({ pdf, number }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let renderTask;
    (async () => {
      try {
        const page = await pdf.getPage(number);
        if (cancelled) return;
        const pageWidth = page.getViewport({ scale: 1 }).width;
        const available = Math.max(280, Math.min(wrapRef.current?.clientWidth || 680, 760));
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const displayScale = available / pageWidth;
        const viewport = page.getViewport({ scale: displayScale * pixelRatio });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${Math.ceil(viewport.width / pixelRatio)}px`;
        canvas.style.height = `${Math.ceil(viewport.height / pixelRatio)}px`;
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        await renderTask.promise;
      } catch (cause) {
        if (!cancelled && cause?.name !== 'RenderingCancelledException') setError('Не удалось показать страницу. PDF можно скачать кнопкой выше.');
      }
    })();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pdf, number]);

  return <div className="shift-pdf-page" ref={wrapRef}>
    <span>Страница {number}</span>
    {error ? <p role="alert">{error}</p> : <canvas ref={canvasRef} aria-label={`Страница ${number} отчёта`} />}
  </div>;
}

export default function PdfPreview({ url }) {
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState('');
  const [visiblePages, setVisiblePages] = useState(2);

  useEffect(() => {
    let cancelled = false;
    let loading;
    setPdf(null);
    setError('');
    setVisiblePages(2);
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
        loading = pdfjs.getDocument({ url });
        const document = await loading.promise;
        if (cancelled) { await document.destroy(); return; }
        setPdf(document);
      } catch {
        if (!cancelled) setError('Предпросмотр недоступен. Скачивание PDF работает независимо от него.');
      }
    })();
    return () => { cancelled = true; loading?.destroy(); };
  }, [url]);

  return <section className="shift-pdf-preview" aria-label="Предпросмотр PDF">
    <h3>Предпросмотр документа</h3>
    {error ? <p role="alert">{error}</p> : pdf ? <>
      <p className="shift-pdf-page-count">{pdf.numPages} стр. · показано {Math.min(pdf.numPages, visiblePages)}. Полный документ также доступен по кнопке «Скачать PDF».</p>
      {Array.from({ length: Math.min(pdf.numPages, visiblePages) }, (_, index) => <PdfPage key={index} pdf={pdf} number={index + 1} />)}
      {visiblePages < pdf.numPages ? <button type="button" className="shift-pdf-more" onClick={() => setVisiblePages(count => Math.min(pdf.numPages, count + 2))}>Показать ещё страницы</button> : null}
    </> : <p className="shift-pdf-page-count">Подготавливаем предпросмотр…</p>}
  </section>;
}
