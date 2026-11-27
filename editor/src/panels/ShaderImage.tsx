// The picture row of the Shader section (halftone, dither): the stored image the layer prints instead of a generated field. Choose one of the
// document's assets (or upload a file), or remove it; every change is one undo step through `actions.setShader`.

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../app/Icon';
import type { ContextMenuItem } from '../app/ContextMenu';
import { assetRef, shaderImageId } from '../assets/refs';
import { useEditor } from '../editor/context';
import type { NodeData } from '../model/types';
import { importImageFiles } from './assetActions';
import { useAssetsState } from './assetHooks';
import { assetSize, assetTitle, kindLabel } from './assetLogic';
import { AssetThumb } from './AssetThumb';
import { MenuButton } from './fields';
import { isPrintableMime } from '../shader/spec';

export function ShaderImageRow({ node }: { node: NodeData }) {
  const editor = useEditor();
  const { assets } = useAssetsState(editor);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = shaderImageId(node);
  const record = id ? editor.assets.get(id) : undefined;
  useEffect(() => setPicking(false), [node.id]);

  const set = (assetId: string | null) => editor.actions.setShader(node.id, { image: assetId ? assetRef(assetId) : null });
  const upload = async (files: FileList | null) => {
    const [stored] = await importImageFiles(editor, files ?? []);
    if (!stored) return;
    if (isPrintableMime(stored.mime)) set(stored.id);
    else editor.ui.toast('That file is stored in the Assets tab, but a shader prints raster pictures (PNG, JPEG, WebP). Upload a raster version.', 'warn');
  };

  const items: ContextMenuItem[] = [
    { id: 'shader-image-choose', testId: 'shader-image-choose', label: 'Choose from assets…', onSelect: () => setPicking(!picking) },
    { id: 'shader-image-upload', testId: 'shader-image-upload', label: 'Upload…', onSelect: () => fileRef.current?.click() },
  ];
  if (id) items.push({ id: 'shader-image-clear', testId: 'shader-image-clear', label: 'Remove picture', separatorBefore: true, danger: true, onSelect: () => set(null) });

  const choices = assets.filter((a) => isPrintableMime(a.mime));
  return (
    <>
      <div className="at-currentimage" data-testid="shader-image" data-tip="Print this picture instead of the generated field">
        {id ? (
          <AssetThumb id={id} className="at-currentimage__thumb" />
        ) : (
          <span className="at-currentimage__thumb at-currentimage__thumb--empty" aria-hidden="true">
            <Icon name="image" size={12} />
          </span>
        )}
        <span className="at-currentimage__text">
          <span className={`at-currentimage__title${id ? '' : ' at-currentimage__title--muted'}`}>{id ? (record ? assetTitle(record) : `Image ${id.slice(0, 8)}`) : 'Generated field'}</span>
          <span className="at-hint">{id ? (record ? assetSize(record) : 'Not in the asset store: the layer prints its generated field') : 'Choose a picture to print instead'}</span>
        </span>
        <MenuButton icon="more" title="Picture actions" items={items} testId="shader-image-actions" />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        hidden
        onChange={(e) => {
          void upload(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      {picking && (
        <div className="at-popover" data-testid="shader-image-card">
          {choices.length === 0 ? (
            <p className="at-hint">No raster images stored yet. Upload one, or generate it in the Assets tab.</p>
          ) : (
            <div className="at-assets__grid at-assets__grid--compact" role="list">
              {choices.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`at-asset${a.id === id ? ' is-selected' : ''}`}
                  data-tip={`${assetTitle(a)} (${kindLabel(a.kind)}, ${assetSize(a)})`}
                  onClick={() => {
                    set(a.id);
                    setPicking(false);
                  }}
                  data-testid="shader-image-tile"
                  data-asset-id={a.id}
                >
                  <span className="at-asset__frame">
                    <AssetThumb id={a.id} />
                  </span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="at-btn" onClick={() => setPicking(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
