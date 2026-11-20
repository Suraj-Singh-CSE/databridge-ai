import { useEffect } from 'react';

/** Sets the browser tab title to "<title> · DataBridge AI". */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · DataBridge AI` : 'DataBridge AI';
  }, [title]);
}
