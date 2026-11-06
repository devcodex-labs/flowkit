import { useEffect, useId, useRef, useState } from 'react';
let queue = Promise.resolve();
export function Mermaid({ source, title, description }: { source: string; title: string; description: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    setError(false);
    const render = async () => {
      if (disposed) return;
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', flowchart: { useMaxWidth: false } });
      const { svg } = await mermaid.render(`flowkit-${id}`, source);
      if (!disposed && target.current) target.current.innerHTML = svg;
    };
    queue = queue.then(render).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [id, source]);
  return <figure className="flowkit-figure"><div tabIndex={0} role="region" aria-label={`${title}，可横向滚动`} className="flowkit-diagram"><div ref={target} data-flowkit-diagram /></div>{error && <p role="alert">流程图暂时无法显示，请阅读下面的执行顺序或查看源码。</p>}<figcaption><strong>{title}</strong>：{description}</figcaption><details><summary>查看 Mermaid 源码</summary><pre>{source}</pre></details></figure>;
}
