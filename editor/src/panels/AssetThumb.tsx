import { useEffect, useReducer } from 'react';
import { useEditor } from '../editor/context';

/**
 * An asset's image. The URL is a transparent pixel until the bytes arrive; the thumb re-renders when
 * they do and swaps in the real image.
 */
export function AssetThumb({ id, className = '', alt = '' }: { id: string; className?: string; alt?: string }) {
  const editor = useEditor();
  const [, reload] = useReducer((n: number) => n + 1, 0);
  useEffect(() => editor.assets.onLoaded((loaded) => loaded === id && reload()), [editor, id]);
  return <img className={`at-thumb ${className}`.trim()} src={editor.assets.urlFor(id)} alt={alt} draggable={false} />;
}
