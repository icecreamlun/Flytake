import { useEffect, useState, type FC } from 'react';
import { TILES_PROVIDER } from '../config';
import { runtime } from '../scene/runtime';
import { useFlytake } from '../state/store';

/**
 * Google Maps Platform attribution for Photorealistic 3D Tiles: the outlined "Google Maps"
 * logo (unmodified, 18 px, clear space around it) plus the data providers of the tiles that
 * are currently displayed, sorted by frequency (collected by GoogleCloudAuthPlugin).
 * Rendered above every other overlay (including the letterbox bars) whenever tiles are on.
 */
export const Attribution: FC = () => {
  const [text, setText] = useState('');
  const tilesError = useFlytake((s) => s.tilesError);

  useEffect(() => {
    if (TILES_PROVIDER == null) return;
    const update = () => {
      const tiles = runtime.tiles;
      if (tiles == null) return;
      const value = tiles
        .getAttributions()
        .filter((a) => a.type === 'string')
        .map((a) => String(a.value))
        .join('; ');
      setText((prev) => (prev === value ? prev : value));
    };
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, []);

  if (TILES_PROVIDER == null || tilesError != null) return null;
  return (
    <div className="attribution">
      <img className="attribution-logo" src="/google-maps-logo.svg" alt="Google Maps" height={18} />
      <span className="attribution-text" title={text}>
        {text}
      </span>
    </div>
  );
};
